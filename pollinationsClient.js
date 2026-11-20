// ═══════════════════════════════════════════════════════
// pollinationsClient.js
// Proveedor GRATUITO y SIN CLAVE: la API publica de
// Pollinations, compatible con OpenAI, con streaming SSE real.
// Es el respaldo universal en la cadena de failover: si no hay
// GROQ_API_KEY configurada, el agente SIGUE FUNCIONANDO sin que
// el usuario tenga que pegar ninguna clave. Verificado en vivo
// el 2026-09-16: POST https://text.pollinations.ai/openai con
// {"stream": true} devuelve deltas SSE reales sin autenticacion.
// ═══════════════════════════════════════════════════════

const { buildSystemPrompt } = require('./groqClient');
const { accumulateToolCallDeltas, finalizeToolCalls } = require('./toolsCatalog');

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
// v6: el modelo por defecto ya NO es 'openai-fast' (gpt-oss-20b).
// Verificado en vivo el 2026-10-23: con prompts de agente (system
// largo + comandos tipo "Crear script:"), gpt-oss corta el stream
// tras el razonamiento y nunca entrega contenido (y en no-stream
// devuelve 400 "unexpected tokens... to=Crear" de su parser
// harmony). El modelo 'openai' en streaming entrega el contenido
// completo con el mismo payload. Override: POLLINATIONS_MODEL.
const DEFAULT_MODEL = process.env.POLLINATIONS_MODEL || 'openai';

/**
 * Chat con streaming SSE real. Misma firma que groqClient/
 * ollamaClient para que el failover sea
 * transparente: onDelta(chunk, fullText) por cada fragmento.
 */
async function streamChat({ model, messages, signal, onDelta }) {
  const resp = await fetch(POLLINATIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      stream: true,
      temperature: 0.13,
      // Seed distinta por intento: el pool gratuito de Pollinations
      // enruta por payload y cachea errores; variar la seed evita
      // repetir el mismo nodo/cache en los reintentos del failover.
      seed: Math.floor(Math.random() * 1_000_000_000),
    }),
  });

  if (!resp.ok) {
    const err = new Error(`Error ${resp.status} del servicio de chat`);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // linea SSE incompleta o keepalive, se ignora
      }
      // Si el upstream manda el error DENTRO del stream, se lanza
      // como error real en vez de terminar con una respuesta vacía
      // silenciosa (el fallo histórico de este proveedor).
      if (parsed.error) {
        const err = new Error(`Error del servicio de chat: ${parsed.error.message || 'desconocido'}`);
        err.status = parsed.error.status || 502;
        throw err;
      }
      const delta = parsed.choices?.[0]?.delta?.content || '';
      if (delta) {
        result += delta;
        if (onDelta) onDelta(delta, result);
      }
    }
  }

  return result;
}

async function checkHealth() {
  try {
    const r = await fetch(POLLINATIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }),
    });
    if (!r.ok) return { ready: false, model: DEFAULT_MODEL, error: `HTTP ${r.status}` };
    return { ready: true, model: DEFAULT_MODEL };
  } catch (e) {
    return { ready: false, model: DEFAULT_MODEL, error: e.message };
  }
}

/**
 * Function calling (H1) con degradación EXPLÍCITA: Pollinations es
 * un pool gratuito y su soporte de `tools` no está garantizado.
 * Se intenta con tools; si el upstream rechaza el parámetro
 * (400 mencionando tools/function), se reintenta SIN tools y se
 * devuelve toolsSupported:false para que el turno use el protocolo
 * de texto. Nunca se finge que hubo tools.
 */
async function streamChatWithTools({ model, messages, tools, signal, onDelta }) {
  const payload = {
    model: model || DEFAULT_MODEL,
    messages,
    stream: true,
    temperature: 0.13,
    seed: Math.floor(Math.random() * 1_000_000_000),
    tools: tools || [],
    tool_choice: 'auto',
  };
  let resp;
  try {
    resp = await fetch(POLLINATIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw e;
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = JSON.stringify(await resp.json()); } catch { detail = await resp.text().catch(() => ''); }
    if (resp.status === 400 && /tool|function/i.test(detail)) {
      console.error('[baro] Pollinations no acepta tools, degradando a texto');
      const text = await streamChat({ model, messages, signal, onDelta });
      return { text, toolCalls: [], finishReason: null, toolsSupported: false };
    }
    const err = new Error(`Error ${resp.status} del servicio de chat`);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';
  let toolCallsRaw = [];
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.error) {
        const err = new Error(`Error del servicio de chat: ${parsed.error.message || 'desconocido'}`);
        err.status = parsed.error.status || 502;
        throw err;
      }
      const choice = parsed.choices?.[0] || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        result += delta.content;
        if (onDelta) onDelta(delta.content, result);
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        toolCallsRaw = accumulateToolCallDeltas(toolCallsRaw, delta.tool_calls);
      }
    }
  }

  return { text: result, toolCalls: finalizeToolCalls(toolCallsRaw), finishReason, toolsSupported: true };
}

module.exports = { DEFAULT_MODEL, buildSystemPrompt, streamChat, streamChatWithTools, checkHealth };

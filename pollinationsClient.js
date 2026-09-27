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

const POLLINATIONS_URL = 'https://text.pollinations.ai/openai';
const DEFAULT_MODEL = process.env.POLLINATIONS_MODEL || 'openai-fast';

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
    }),
  });

  if (!resp.ok) {
    const err = new Error(`Error ${resp.status} de Pollinations (gratis)`);
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
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          result += delta;
          if (onDelta) onDelta(delta, result);
        }
      } catch {
        // linea SSE incompleta o keepalive, se ignora
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

module.exports = { DEFAULT_MODEL, buildSystemPrompt, streamChat, checkHealth };

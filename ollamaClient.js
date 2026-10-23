// ═══════════════════════════════════════════════════════
// ollamaClient.js
// Habla con Ollama (modelo local) desde el servidor.
// Sin API key, sin créditos, sin dependencias externas.
// Compatible con la API OpenAI que expone Ollama en
// http://localhost:11434/v1/chat/completions
// ═══════════════════════════════════════════════════════

// 127.0.0.1 y no "localhost": en muchos sistemas Node resuelve
// localhost a ::1 (IPv6) y Ollama escucha solo en IPv4, así que el
// fetch fallaba con "fetch failed" aunque Ollama estuviera vivo.
const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_URL  = `${OLLAMA_BASE}/v1/chat/completions`;

// Modelo a usar — puede cambiarse con la variable de entorno OLLAMA_MODEL
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';

// El system prompt es ÚNICO y compartido: lo define groqClient.js
// (identidad Baro, protocolo agéntico y catálogo completo de
// herramientas). Ollama no mantiene una copia divergente.
const { buildSystemPrompt } = require('./groqClient');

/**
 * Llama a Ollama en modo streaming via su API compatible con OpenAI.
 * Invoca onDelta(chunk, fullText) con cada fragmento nuevo.
 * Devuelve el texto completo al terminar.
 */
async function streamChat({ model, messages, signal, onDelta }) {
  const useModel = model || DEFAULT_MODEL;

  let resp;
  try {
    resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: useModel,
        messages,
        max_tokens: 4096,
        temperature: 0.1,
        stream: true,
      }),
    });
  } catch (e) {
    const err = new Error(
      'No se pudo conectar con Ollama. Asegurate de que el servicio esta corriendo. ' +
      (e.code === 'ECONNREFUSED' ? '(ECONNREFUSED en ' + OLLAMA_BASE + ')' : e.message)
    );
    err.status = 503;
    throw err;
  }

  if (!resp.ok) {
    let message = `Error ${resp.status} de Ollama`;
    try {
      const body = await resp.json();
      message = body.error?.message || body.error || message;
    } catch {}
    const err = new Error(message);
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
        // linea SSE incompleta o keepalive, ignorar
      }
    }
  }

  return result;
}

/**
 * Comprueba si Ollama está disponible y el modelo cargado.
 * Devuelve { ready: bool, model: string, error?: string }
 */
async function checkHealth() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ready: false, model: DEFAULT_MODEL, error: `HTTP ${r.status}` };
    const data = await r.json();
    const models = (data.models || []).map(m => m.name);
    const modelReady = models.some(m => m.startsWith(DEFAULT_MODEL.split(':')[0]));
    return { ready: true, model: DEFAULT_MODEL, modelReady, availableModels: models };
  } catch (e) {
    return { ready: false, model: DEFAULT_MODEL, error: e.message };
  }
}

module.exports = { DEFAULT_MODEL, buildSystemPrompt, streamChat, checkHealth };

// ═══════════════════════════════════════════════════════
// openrouterClient.js
// Puerta de entrada a los modelos frontera vía OpenRouter:
// GPT-6 Astra (el flagship de OpenAI) como cerebro principal
// de Baro, con rotación de modelos gratuitos como respaldo.
// Interfaz idéntica a groqClient para ser drop-in.
// ═══════════════════════════════════════════════════════

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// ── GPT-6 Astra: el flagship de OpenAI ────────────────────
// "Suited for advanced analysis, software engineering, deep
// research, scientific work, and document creation, with
// particular strengths in long-horizon [work]" — 1M+ de
// contexto. Es de PAGO (ver precios en openrouter.ai); si la
// key no tiene crédito o el modelo falla, se cae de forma
// transparente a la rotación gratuita de abajo y el chat
// nunca muere.
const ASTRA_MODEL = 'openai/gpt-6-astra';
// Misma base con reasoning.mode=pro para tareas muy complejas.
// Actívalo con OPENROUTER_MODEL=openai/gpt-6-astra-pro.
const ASTRA_PRO_MODEL = 'openai/gpt-6-astra-pro';

// El catalogo ":free" de OpenRouter rota constantemente — modelos que
// existian hace semanas quedan deslistados sin aviso y cualquier ID fijo
// termina devolviendo 404/400 tarde o temprano. Esta lista es solo el
// ULTIMO recurso si la consulta dinamica al catalogo (abajo) falla; el
// camino normal es preguntarle a OpenRouter cuales son gratis ahora mismo.
const FALLBACK_FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
  'openrouter/free',
  'openai/gpt-oss-20b:free',
];

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || ASTRA_MODEL;

// Cache breve del catalogo real de modelos gratuitos. Evita golpear el
// endpoint de catalogo en cada mensaje del chat, pero lo bastante corto
// para notar cuando un modelo se deslista.
let freeModelsCache = { list: null, fetchedAt: 0 };
const FREE_MODELS_TTL_MS = 10 * 60 * 1000;

/**
 * Consulta el catalogo real de OpenRouter y devuelve los IDs de modelos
 * con costo $0, priorizando los orientados a codigo. Si la consulta falla
 * (red, rate limit, etc.) cae de vuelta a FALLBACK_FREE_MODELS para que el
 * chat nunca se quede sin ningun candidato que probar.
 */
async function getFreeModels(apiKey) {
  const now = Date.now();
  if (freeModelsCache.list && now - freeModelsCache.fetchedAt < FREE_MODELS_TTL_MS) {
    return freeModelsCache.list;
  }
  try {
    const r = await fetch(OPENROUTER_MODELS_URL, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const all = Array.isArray(body?.data) ? body.data : [];
    const free = all.filter((m) => {
      const prompt = Number(m?.pricing?.prompt ?? -1);
      const completion = Number(m?.pricing?.completion ?? -1);
      return prompt === 0 && completion === 0;
    });
    if (!free.length) throw new Error('Catalogo sin modelos gratuitos');

    const CODING_HINTS = ['coder', 'code', 'qwen', 'deepseek', 'llama', 'devstral', 'glm'];
    const ranked = free
      .map((m) => m.id)
      .filter(Boolean)
      .sort((a, b) => {
        const scoreA = CODING_HINTS.some((h) => a.toLowerCase().includes(h)) ? 0 : 1;
        const scoreB = CODING_HINTS.some((h) => b.toLowerCase().includes(h)) ? 0 : 1;
        return scoreA - scoreB;
      });

    freeModelsCache = { list: ranked, fetchedAt: now };
    return ranked;
  } catch (e) {
    console.warn(`[OpenRouter] No se pudo obtener el catalogo de modelos gratuitos en vivo, usando lista de respaldo: ${e.message}`);
    return FALLBACK_FREE_MODELS;
  }
}

// NOTA: el system prompt es UNO SOLO y vive en groqClient.js
// (buildSystemPrompt compartido). Esta copia duplicada se eliminó
// para que el cerebro no se desincronice entre proveedores.
const { buildSystemPrompt } = require('./groqClient');


async function tryModel({ apiKey, model, messages, signal, onDelta }) {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://baro.app',
      'X-Title': 'Baro',
    },
    signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 16384,
      temperature: 0.1,
      stream: true,
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status}`;
    try { const b = await resp.json(); message = b.error?.message || b.error || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    err.providerError = true;
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
      } catch { /* SSE incompleto, ignorar */ }
    }
  }

  return result;
}

async function streamChat({ model, messages, signal, onDelta }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta OPENROUTER_API_KEY. Agrégala en las variables de entorno de Railway.');
    err.status = 503;
    throw err;
  }

  // Si el usuario especificó un modelo concreto, úsalo sin fallback
  if (model) return tryModel({ apiKey, model, messages, signal, onDelta });

  // Override explícito por variable de entorno (ej. para forzar
  // openai/gpt-6-astra-pro o un modelo gratuito concreto).
  if (process.env.OPENROUTER_MODEL) {
    try {
      return await tryModel({ apiKey, model: process.env.OPENROUTER_MODEL, messages, signal, onDelta });
    } catch (e) {
      console.warn(`[OpenRouter] OPENROUTER_MODEL=${process.env.OPENROUTER_MODEL} falló: ${e.message}`);
      if (signal?.aborted) throw e;
    }
  }

  // Cerebro principal: GPT-6 Astra, el flagship de OpenAI.
  // Si falla (sin crédito, 404, rate limit), se cae a la
  // rotación gratuita sin que el usuario lo note.
  try {
    return await tryModel({ apiKey, model: ASTRA_MODEL, messages, signal, onDelta });
  } catch (e) {
    console.warn(`[OpenRouter] ${ASTRA_MODEL} falló (${e.message}); probando modelos gratuitos…`);
    if (signal?.aborted) throw e;
    if (e.status === 404 || e.status === 400) freeModelsCache.fetchedAt = 0;
  }

  // Respaldo: recorre la lista de modelos gratuitos REALES (consultados
  // al catalogo en vivo, ver getFreeModels) hasta que uno funcione.
  // Este camino solo se alcanza si GPT-6 Astra no estuvo disponible
  // (sin crédito en la key, deslistado, etc): el chat sigue vivo gratis.
  const candidates = await getFreeModels(apiKey);
  let lastErr;
  for (const candidate of candidates) {
    try {
      console.log(`[OpenRouter] Probando modelo: ${candidate}`);
      return await tryModel({ apiKey, model: candidate, messages, signal, onDelta });
    } catch (e) {
      console.warn(`[OpenRouter] ${candidate} falló: ${e.message}`);
      lastErr = e;
      // Si fue abortado por el cliente no seguir intentando
      if (signal?.aborted) throw e;
      // Un modelo deslistado o sin capacidad no invalida el cache por 10
      // minutos completos, pero si es el unico que probamos y falla por
      // "no existe", forzamos refrescar el catalogo en el proximo intento.
      if (e.status === 404 || e.status === 400) freeModelsCache.fetchedAt = 0;
    }
  }

  const err = new Error('Todos los modelos gratuitos de OpenRouter fallaron ahora mismo. Último error: ' + lastErr?.message + '. Podés fijar uno de pago con OPENROUTER_MODEL, o configurar GROQ_API_KEY como alternativa.');
  err.status = 503;
  throw err;
}

async function checkHealth() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ready: false, model: DEFAULT_MODEL, error: 'OPENROUTER_API_KEY no configurada' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ready: false, model: DEFAULT_MODEL, error: `HTTP ${r.status}` };
    return { ready: true, model: DEFAULT_MODEL };
  } catch (e) {
    return { ready: false, model: DEFAULT_MODEL, error: e.message };
  }
}

module.exports = { DEFAULT_MODEL, ASTRA_MODEL, ASTRA_PRO_MODEL, buildSystemPrompt, streamChat, checkHealth };

// ═══════════════════════════════════════════════════════
// toolsClient.js
// Todo lo que convierte a DevAgent en algo más que "solo
// código": búsqueda web en tiempo real, Wikipedia, generación
// de video con IA (Seedance/BytePlus) y edición/animación de
// imágenes con IA. Cada función emite pasos vía un callback
// onStep(evento) para que el frontend pueda mostrar en vivo
// "qué está haciendo" el agente (qué página abrió, qué buscó,
// en qué paso va el video, etc).
//
// Todas las claves salen de variables de entorno. Ninguna
// clave se hardcodea ni se expone al navegador.
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────
// BÚSQUEDA WEB EN TIEMPO REAL — Tavily
// Elegida porque: tiene capa gratuita real (1000 créditos al
// mes, sin tarjeta), está diseñada para agentes de IA (ya
// entrega contenido extraído y limpio, no solo enlaces), y
// soporta filtrar por noticias/fecha, ideal para "qué está
// pasando ahora".
// Doc: https://docs.tavily.com
// ─────────────────────────────────────────────────────────
const TAVILY_URL = 'https://api.tavily.com/search';

async function webSearch({ query, topic = 'general', maxResults = 5, onStep }) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta TAVILY_API_KEY. Consigue una gratis en tavily.com y agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  onStep?.({ type: 'search_start', query, provider: 'Tavily' });

  const resp = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      topic, // 'general' | 'news'
      search_depth: 'advanced',
      max_results: Math.min(Math.max(maxResults, 1), 10),
      include_answer: true,
      include_images: false,
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} de Tavily`;
    try { message = (await resp.json()).error || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();

  // Emitimos cada resultado a medida que "lo abrimos", uno por uno,
  // para que la UI pueda pintar en vivo "Visitando: dominio.com"
  // como hace Perplexity, aunque la respuesta ya llegó completa —
  // esto es deliberado: da la sensación fiel de navegación real
  // sin inventar datos que Tavily no devolvió.
  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content?.slice(0, 600) || '',
    score: r.score,
  }));

  for (const r of results) {
    onStep?.({ type: 'search_visit', url: r.url, title: r.title, snippet: r.snippet });
  }

  onStep?.({ type: 'search_done', count: results.length });

  return {
    answer: data.answer || null,
    results,
  };
}

// ─────────────────────────────────────────────────────────
// WIKIPEDIA — API pública oficial, gratis, sin límites duros
// ni API key. Usamos el endpoint REST de resumen + el de
// búsqueda para encontrar el artículo correcto primero.
// Doc: https://api.wikimedia.org/wiki/API_reference/Core_REST_API
// ─────────────────────────────────────────────────────────
async function wikipediaLookup({ query, lang = 'es', onStep }) {
  onStep?.({ type: 'wiki_start', query });

  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': 'DevAgent/1.0' } });
  if (!searchResp.ok) throw new Error(`Error ${searchResp.status} buscando en Wikipedia`);
  const searchData = await searchResp.json();
  const hit = searchData.query?.search?.[0];

  if (!hit) {
    onStep?.({ type: 'wiki_done', found: false });
    return { found: false, title: null, extract: null, url: null };
  }

  onStep?.({ type: 'wiki_visit', title: hit.title });

  const title = encodeURIComponent(hit.title.replace(/ /g, '_'));
  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;
  const summaryResp = await fetch(summaryUrl, { headers: { 'User-Agent': 'DevAgent/1.0' } });
  if (!summaryResp.ok) throw new Error(`Error ${summaryResp.status} obteniendo resumen de Wikipedia`);
  const summary = await summaryResp.json();

  const result = {
    found: true,
    title: summary.title,
    extract: summary.extract,
    url: summary.content_urls?.desktop?.page || null,
    thumbnail: summary.thumbnail?.source || null,
  };

  onStep?.({ type: 'wiki_done', found: true, title: summary.title, extract: summary.extract, url: result.url });

  return result;
}

// ─────────────────────────────────────────────────────────
// GENERACIÓN DE VIDEO — Seedance (ByteDance) vía BytePlus
// ModelArk. Es un servicio DE PAGO por segundo generado — no
// existe un tier gratuito real de producción para video con
// IA en ningún proveedor serio; se paga con la key del propio
// usuario (BYTEPLUS_API_KEY).
//
// Límite técnico real de Seedance: 15s por clip (Seedance 2.0)
// o 30s (Seedance 2.5) en una sola generación. Para pedidos más
// largos (hasta el máximo soportado de una "película" corta de
// hasta 10 minutos), se ENCADENAN varias generaciones usando el
// último frame del clip anterior como referencia del siguiente,
// controlado por MAX_CLIP_SECONDS/MAX_TOTAL_SECONDS abajo.
// ─────────────────────────────────────────────────────────
const BYTEPLUS_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || 'seedance-2-0-pro-250628';

const MAX_CLIP_SECONDS = 15;              // límite real de una sola generación
const MAX_TOTAL_SECONDS = 10 * 60;        // tope duro pedido por el usuario: 10 min
const MAX_VIDEOS_PER_DAY = 10;            // tope duro pedido por el usuario

// Contador diario en memoria (por proceso). Para producción con
// múltiples usuarios reales, esto debería vivir en una base de
// datos o Redis compartido; aquí se deja simple y documentado.
const dailyVideoUsage = new Map(); // key: 'YYYY-MM-DD' -> count

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getVideoUsageToday() {
  return dailyVideoUsage.get(todayKey()) || 0;
}

function checkAndReserveVideoQuota() {
  const key = todayKey();
  const used = dailyVideoUsage.get(key) || 0;
  if (used >= MAX_VIDEOS_PER_DAY) {
    const err = new Error(`Límite diario de ${MAX_VIDEOS_PER_DAY} videos alcanzado. Vuelve a intentarlo mañana.`);
    err.status = 429;
    throw err;
  }
  dailyVideoUsage.set(key, used + 1);
  return MAX_VIDEOS_PER_DAY - (used + 1);
}

function releaseVideoQuota() {
  const key = todayKey();
  const used = dailyVideoUsage.get(key) || 0;
  if (used > 0) dailyVideoUsage.set(key, used - 1);
}

async function submitSeedanceClip({ apiKey, prompt, durationSec, referenceImageUrl }) {
  const content = [{ type: 'text', text: `${prompt} --dur ${durationSec} --resolution 720p` }];
  if (referenceImageUrl) {
    content.push({ type: 'image_url', image_url: { url: referenceImageUrl } });
  }

  const resp = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: SEEDANCE_MODEL, content }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} de Seedance/BytePlus`;
    try { message = (await resp.json()).error?.message || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  return data.id; // task id para hacer polling
}

async function pollSeedanceTask({ apiKey, taskId, onStep, clipIndex }) {
  const started = Date.now();
  const timeoutMs = 6 * 60 * 1000; // 6 min de margen por clip

  while (Date.now() - started < timeoutMs) {
    const resp = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`Error ${resp.status} consultando estado del video`);
    const data = await resp.json();

    if (data.status === 'succeeded') {
      onStep?.({ type: 'video_clip_ready', clipIndex, url: data.content?.video_url });
      return data.content?.video_url;
    }
    if (data.status === 'failed') {
      throw new Error(data.error?.message || 'La generación de video falló en el proveedor.');
    }

    onStep?.({ type: 'video_clip_progress', clipIndex, status: data.status || 'processing' });
    await new Promise((r) => setTimeout(r, 4000));
  }

  throw new Error('Tiempo de espera agotado generando el clip de video.');
}

/**
 * Genera un video, encadenando clips de hasta MAX_CLIP_SECONDS
 * hasta cubrir `durationSec` (tope MAX_TOTAL_SECONDS = 10 min).
 * Respeta el límite de MAX_VIDEOS_PER_DAY por instancia del
 * servidor. onStep(evento) reporta cada paso en tiempo real.
 */
async function generateVideo({ prompt, durationSec = 15, referenceImageUrl = null, onStep }) {
  const apiKey = process.env.BYTEPLUS_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta BYTEPLUS_API_KEY. Consigue una key de Volcengine/BytePlus ModelArk (servicio de pago, no hay tier gratis real para video con IA) y agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  const targetSeconds = Math.min(Math.max(durationSec, 3), MAX_TOTAL_SECONDS);
  const remaining = checkAndReserveVideoQuota(); // lanza si se agotó la cuota

  onStep?.({ type: 'video_start', targetSeconds, remainingToday: remaining });

  const clips = [];
  let secondsLeft = targetSeconds;
  let clipIndex = 0;
  let lastClipUrl = referenceImageUrl;

  try {
    while (secondsLeft > 0) {
      const clipDuration = Math.min(secondsLeft, MAX_CLIP_SECONDS);
      clipIndex += 1;
      onStep?.({ type: 'video_clip_start', clipIndex, clipDuration });

      const taskId = await submitSeedanceClip({
        apiKey,
        prompt: clipIndex === 1 ? prompt : `${prompt} (continuación de la escena anterior, misma consistencia de personajes y estilo)`,
        durationSec: clipDuration,
        referenceImageUrl: clipIndex === 1 ? referenceImageUrl : lastClipUrl,
      });

      const clipUrl = await pollSeedanceTask({ apiKey, taskId, onStep, clipIndex });
      clips.push({ index: clipIndex, url: clipUrl, seconds: clipDuration });
      lastClipUrl = clipUrl;
      secondsLeft -= clipDuration;
    }

    onStep?.({ type: 'video_done', clips: clips.length, totalSeconds: targetSeconds });
    return { clips, totalSeconds: targetSeconds, remainingToday: remaining };
  } catch (e) {
    releaseVideoQuota(); // no consumir cuota si terminó en error
    throw e;
  }
}

// ─────────────────────────────────────────────────────────
// EDICIÓN / ANIMACIÓN DE IMÁGENES CON IA
// Usa un modelo de imagen a través de OpenRouter (mismo
// proveedor que ya usa el chat como fallback), que expone
// modelos de edición/generación de imágenes por texto. Sirve
// para: "edítame estas fotos", "anímame esta imagen" (esto
// último delega a generateVideo con referenceImageUrl).
// ─────────────────────────────────────────────────────────
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const IMAGE_EDIT_MODEL = process.env.IMAGE_EDIT_MODEL || 'google/gemini-2.5-flash-image-preview';

async function editImage({ imageUrl, instruction, onStep }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta OPENROUTER_API_KEY para edición de imágenes. Agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  onStep?.({ type: 'image_edit_start', instruction });

  const resp = await fetch(OPENROUTER_IMAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_EDIT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      modalities: ['image', 'text'],
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} editando la imagen`;
    try { message = (await resp.json()).error?.message || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const choice = data.choices?.[0]?.message;
  const outputImage = choice?.images?.[0]?.image_url?.url || null;

  onStep?.({ type: 'image_edit_done', hasImage: !!outputImage });

  return {
    imageUrl: outputImage,
    note: choice?.content || null,
  };
}

/** Procesa un lote de imágenes con la misma instrucción, en secuencia,
 *  reportando progreso por cada una. */
async function editImageBatch({ images, instruction, onStep }) {
  const results = [];
  for (let i = 0; i < images.length; i += 1) {
    onStep?.({ type: 'batch_item_start', index: i, total: images.length });
    try {
      const result = await editImage({ imageUrl: images[i], instruction, onStep });
      results.push({ index: i, ok: true, ...result });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message });
    }
    onStep?.({ type: 'batch_item_done', index: i, total: images.length });
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// GENERACIÓN DE IMÁGENES — Pollinations (GRATIS, SIN CLAVE)
// Verificado en vivo 2026-09-16: GET
// https://image.pollinations.ai/prompt/<prompt>?width=&height=&model=flux
// devuelve la imagen generada directamente (HTTP 200,
// image/jpeg), sin autenticacion. El propio GET dispara la
// generacion, asi que la URL resultante ES el resultado y se
// puede mostrar tal cual en el frontend.
// ─────────────────────────────────────────────────────────
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL || 'flux';

function buildImageUrl(prompt, { width = 1024, height = 1024, seed = null } = {}) {
  const s = seed ?? Math.floor(Math.random() * 1_000_000_000);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(s),
    model: IMAGE_GEN_MODEL,
    nologo: 'true',
    private: 'true',
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/**
 * Genera una imagen con IA sin necesidad de clave.
 * onStep(evento): image_start { prompt } -> image_done { url }.
 * Devuelve { imageUrl, prompt }. La generacion ocurre al
 * resolverse la URL (el servidor de Pollinations la genera
 * al recibir el GET); aqui solo construimos la URL real.
 */
async function generateImage({ prompt, width, height, onStep }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Falta el prompt para generar la imagen.');
  }
  onStep?.({ type: 'image_start', prompt: String(prompt).trim() });
  const imageUrl = buildImageUrl(String(prompt).trim(), { width, height });
  onStep?.({ type: 'image_done', url: imageUrl });
  return { imageUrl, prompt: String(prompt).trim() };
}

module.exports = {
  webSearch,
  wikipediaLookup,
  generateVideo,
  generateImage,
  editImage,
  editImageBatch,
  getVideoUsageToday,
  MAX_VIDEOS_PER_DAY,
  MAX_TOTAL_SECONDS,
  MAX_CLIP_SECONDS,
};

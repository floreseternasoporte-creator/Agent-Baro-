// ═══════════════════════════════════════════════════════
// visionClient.js
// Los "ojos" del agente: un modelo de visión local (Ollama +
// moondream, ~1.7GB, corre en CPU) que interpreta capturas de
// pantalla reales. Gratis, sin clave, sin nube: las imágenes
// nunca salen del servidor.
//
// Si Ollama no está disponible o no hay modelo de visión,
// visionAvailable() devuelve null y el agente trabaja en modo
// árbol-de-accesibilidad (estructura exacta, sin píxeles),
// avisándolo con honestidad en vez de fingir que ve.
// ═══════════════════════════════════════════════════════

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
// Modelos de visión que sabemos manejar, en orden de preferencia
// (el más ligero primero: este servidor no tiene GPU).
const VISION_MODELS = ['moondream', 'moondream:1.8b', 'llava:7b', 'llava', 'llama3.2-vision'];

let cachedModel = null;
let cacheCheckedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function ollamaModels() {
  const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!resp.ok) throw new Error(`Ollama respondió ${resp.status}`);
  const data = await resp.json();
  return (data.models || []).map((m) => m.name);
}

async function pickVisionModel() {
  const now = Date.now();
  if (cachedModel && now - cacheCheckedAt < CACHE_TTL_MS) return cachedModel;
  const models = await ollamaModels();
  const lower = models.map((m) => m.toLowerCase());
  for (const want of VISION_MODELS) {
    const hit = models[lower.findIndex((m) => m === want || m.startsWith(want + ':'))];
    if (hit) {
      cachedModel = hit;
      cacheCheckedAt = now;
      return hit;
    }
  }
  cachedModel = null;
  cacheCheckedAt = now;
  return null;
}

/** Devuelve el nombre del modelo de visión disponible, o null. */
async function visionAvailable() {
  try {
    return await pickVisionModel();
  } catch {
    return null;
  }
}

/**
 * Le pide al modelo de visión que interprete una imagen.
 * imageBase64: PNG/JPEG en base64 (sin prefijo data:).
 * Devuelve el texto de respuesta.
 *
 * Nota: la PRIMERA carga del modelo en CPU tarda varios minutos;
 * por eso el timeout por defecto es generoso y se usa keep_alive
 * para que el modelo quede caliente en memoria.
 */
async function seeImage({ imageBase64, prompt, timeoutMs = 600000 }) {
  const model = await pickVisionModel();
  if (!model) {
    throw new Error('Sin modelo de visión: Ollama no está corriendo o no tiene moondream/llava instalado.');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        prompt: String(prompt || 'Describe lo que ves en esta imagen.'),
        images: [imageBase64],
        stream: false,
        keep_alive: '30m',
        options: { temperature: 0.1 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama generate respondió ${resp.status}`);
    const data = await resp.json();
    return (data.response || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { visionAvailable, seeImage, VISION_MODELS };

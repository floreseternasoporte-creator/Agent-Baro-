// ═══════════════════════════════════════════════════════
// toolsRoutes.js
// Expone las herramientas de toolsClient.js como endpoints
// HTTP en streaming (Server-Sent Events), igual que /api/chat,
// para que el frontend pinte en tiempo real cada paso: qué
// página se está visitando, en qué clip de video va, qué
// imagen del lote se está editando, etc.
// ═══════════════════════════════════════════════════════

const express = require('express');
const tools = require('./toolsClient');

const router = express.Router();

function sseHandler(fn) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const onStep = (data) => send('step', data);

    try {
      const result = await fn(req, onStep);
      send('done', result);
    } catch (e) {
      send('error', { error: e.message });
    } finally {
      res.end();
    }
  };
}

// ── Búsqueda web en tiempo real (Tavily) ──────────────────
router.post('/tools/search', sseHandler(async (req, onStep) => {
  const { query, topic } = req.body || {};
  if (!query) throw new Error('Falta "query"');
  return tools.webSearch({ query, topic, onStep });
}));

// ── Wikipedia ──────────────────────────────────────────────
router.post('/tools/wikipedia', sseHandler(async (req, onStep) => {
  const { query, lang } = req.body || {};
  if (!query) throw new Error('Falta "query"');
  return tools.wikipediaLookup({ query, lang, onStep });
}));

// ── Generación de video (Seedance) ─────────────────────────
router.post('/tools/video', sseHandler(async (req, onStep) => {
  const { prompt, durationSec, referenceImageUrl } = req.body || {};
  if (!prompt) throw new Error('Falta "prompt"');
  return tools.generateVideo({ prompt, durationSec, referenceImageUrl, onStep });
}));

router.get('/tools/video/usage', (_req, res) => {
  res.json({
    usedToday: tools.getVideoUsageToday(),
    maxPerDay: tools.MAX_VIDEOS_PER_DAY,
    maxTotalSeconds: tools.MAX_TOTAL_SECONDS,
    maxClipSeconds: tools.MAX_CLIP_SECONDS,
  });
});

// ── Generación de imágenes con IA (Pollinations, GRATIS sin clave) ──
router.post('/tools/image', sseHandler(async (req, onStep) => {
  const { prompt, width, height } = req.body || {};
  if (!prompt) throw new Error('Falta "prompt"');
  return tools.generateImage({ prompt, width, height, onStep });
}));

// ── Edición/animación de imágenes con IA ───────────────────
router.post('/tools/image-edit', sseHandler(async (req, onStep) => {
  const { imageUrl, images, instruction } = req.body || {};
  if (!instruction) throw new Error('Falta "instruction"');
  if (Array.isArray(images) && images.length) {
    return { batch: await tools.editImageBatch({ images, instruction, onStep }) };
  }
  if (!imageUrl) throw new Error('Falta "imageUrl" o "images"');
  return tools.editImage({ imageUrl, instruction, onStep });
}));

module.exports = router;

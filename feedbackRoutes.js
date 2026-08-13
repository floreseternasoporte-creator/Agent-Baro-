const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();
const FEEDBACK_DIR = path.join(__dirname, 'feedback');

function clean(value, max) {
  return String(value || '').trim().slice(0, max);
}

router.post('/feedback', async (req, res) => {
  const body = req.body || {};
  const title = clean(body.title, 160);
  const description = clean(body.description, 8000);
  const steps = clean(body.steps, 4000);
  const severity = ['low', 'medium', 'high', 'blocking'].includes(body.severity) ? body.severity : 'medium';

  if (!title || !description) {
    return res.status(400).json({ error: 'El título y la descripción son obligatorios.' });
  }

  const report = {
    id: crypto.randomUUID(),
    type: 'bug',
    title,
    description,
    steps,
    severity,
    sessionId: clean(body.sessionId, 100) || null,
    page: clean(body.page, 120) || null,
    createdAt: new Date().toISOString(),
  };

  try {
    await fs.mkdir(FEEDBACK_DIR, { recursive: true });
    const file = path.join(FEEDBACK_DIR, `reports-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await fs.appendFile(file, JSON.stringify(report) + '\n', 'utf8');
    return res.status(201).json({ ok: true, id: report.id });
  } catch (error) {
    console.error('[feedback] no se pudo guardar el reporte:', error);
    return res.status(500).json({ error: 'No se pudo guardar el reporte. Inténtalo de nuevo.' });
  }
});

module.exports = router;
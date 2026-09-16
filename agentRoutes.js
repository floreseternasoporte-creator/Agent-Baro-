// ═══════════════════════════════════════════════════════
// routes/agent.js
// Las acciones que hacen que esto sea un agente de verdad
// y no un generador de texto:
//   POST /api/agent/apply-diff   -> escribe el archivo real
//   POST /api/agent/run          -> corre un comando real
//   POST /api/agent/push         -> commit + push real
// Todas operan sobre session.dir, el clon real en disco.
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getSession } = require('./sessionStore');
const git = require('./gitAgent');
const { runCommand, TASK_PRESETS, ALLOWED_BINARIES } = require('./commandRunner');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// Descarga de archivos generados por el agente (Document
// Studio: .docx/.pptx/.xlsx en workspaces/<sid>/docs/).
// Solo sirve archivos DENTRO del workspace de la sesión:
// cualquier intento de salir (..) se rechaza.
// ─────────────────────────────────────────────────────────
router.get('/files/download', (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesión no encontrada o expirada' });
  const rel = String(req.query.file || '').replace(/\\/g, '/');
  if (!rel || rel.includes('\0')) return res.status(400).json({ error: 'Archivo inválido' });
  const base = path.resolve(session.dir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    return res.status(400).json({ error: 'Ruta no permitida' });
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  res.download(full, path.basename(full));
});

router.post('/agent/apply-diff', async (req, res) => {
  const { sessionId, diff } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!session.repoFullName) return res.status(400).json({ error: 'No hay repositorio conectado en esta sesion' });
  if (!diff) return res.status(400).json({ error: 'Falta el contenido del diff' });

  try {
    const results = await git.applyUnifiedDiff(session.dir, diff);
    const failed = results.filter((r) => !r.applied);

    for (const r of results) {
      session.addLog(
        r.applied
          ? r.alreadyApplied
            ? { type: 'info', title: `Ya aplicado: ${r.path}`, detail: 'El archivo real ya tenia este cambio' }
            : { type: 'ok', title: `Aplicado: ${r.path}`, detail: `${r.bytes} bytes escritos en disco real` }
          : { type: 'err', title: `No aplicado: ${r.path || '(desconocido)'}`, detail: r.reason }
      );
    }

    res.json({ results, allApplied: failed.length === 0 });
  } catch (e) {
    session.addLog({ type: 'err', title: 'Error aplicando diff', detail: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/agent/allowed-commands', (_req, res) => {
  res.json({ allowed: ALLOWED_BINARIES, presets: Object.keys(TASK_PRESETS) });
});

router.post('/agent/run', async (req, res) => {
  const { sessionId, preset, binary, args } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!session.repoFullName) return res.status(400).json({ error: 'No hay repositorio conectado en esta sesion' });

  let cmdBinary = binary;
  let cmdArgs = Array.isArray(args) ? args : [];

  if (preset) {
    const p = TASK_PRESETS[preset];
    if (!p) return res.status(400).json({ error: `Preset desconocido: ${preset}` });
    cmdBinary = p.binary;
    cmdArgs = p.args;
  }

  if (!cmdBinary) return res.status(400).json({ error: 'Falta "binary" o "preset"' });

  session.addLog({ type: 'run', title: `Ejecutando: ${cmdBinary} ${cmdArgs.join(' ')}` });
  const result = await runCommand(cmdBinary, cmdArgs, session.dir);

  session.addLog(
    result.ok
      ? { type: 'ok', title: `${cmdBinary} completado`, detail: `codigo de salida 0` }
      : { type: 'err', title: `${cmdBinary} fallo`, detail: result.error || `codigo de salida ${result.code}` }
  );

  res.json(result);
});

router.post('/agent/push', async (req, res) => {
  const { sessionId, message, branch, githubToken } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!session.repoFullName) return res.status(400).json({ error: 'No hay repositorio conectado en esta sesion' });

  const token = githubToken || session.githubToken || process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(400).json({ error: 'Se necesita un GitHub Token con permiso "repo" para hacer push. Agregalo en Configuracion.' });
  }

  try {
    // Aseguramos que el remoto tenga el token vigente antes del push,
    // por si la sesion se reconecto o el token cambio.
    const parsed = git.parseRepoUrl(`https://github.com/${session.repoFullName}`);
    const simpleGit = require('simple-git')(session.dir);
    await simpleGit.remote(['set-url', 'origin', `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.repo}.git`]);

    const result = await git.commitAndPush({
      dir: session.dir,
      message: message || `fix: update via DevAgent ${new Date().toISOString().slice(0, 10)}`,
      branch: branch || session.branch,
      name: process.env.AGENT_GIT_NAME || 'DevAgent',
      email: process.env.AGENT_GIT_EMAIL || 'devagent@users.noreply.github.com',
    });

    session.addLog(
      result.pushed
        ? { type: 'ok', title: `Push exitoso: ${result.files.length} archivo(s)`, detail: result.files.join(', ') }
        : { type: 'info', title: result.reason }
    );

    res.json(result);
  } catch (e) {
    session.addLog({ type: 'err', title: 'Error en push', detail: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/agent/status', async (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!session.repoFullName) return res.json({ hasChanges: false, files: [] });

  try {
    const simpleGit = require('simple-git')(session.dir);
    const status = await simpleGit.status();
    const changed = [...status.modified, ...status.not_added, ...status.created, ...status.deleted];
    res.json({ hasChanges: changed.length > 0, files: changed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/agent/log', (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  res.json({ log: session.actionLog });
});

// ── Memoria a largo plazo ─────────────────────────────────
// GET  /api/agent/memory?sessionId=  -> { memory: [...] }
// POST /api/agent/memory { sessionId, text } -> guarda un dato
// DELETE /api/agent/memory { sessionId, index } -> olvida un dato
// Vive en workspaces/<id>/memory.json: sobrevive reinicios del
// servidor y se inyecta en el system prompt de cada turno.
router.get('/agent/memory', (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  res.json({ memory: session.memory });
});

router.post('/agent/memory', (req, res) => {
  const { sessionId, text } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Falta "text"' });
  const saved = session.addMemory(text);
  res.json({ saved, memory: session.memory });
});

router.delete('/agent/memory', (req, res) => {
  const { sessionId, index } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  const ok = session.forgetMemory(Number(index));
  if (!ok) return res.status(400).json({ error: 'Índice inválido' });
  res.json({ ok: true, memory: session.memory });
});

module.exports = router;

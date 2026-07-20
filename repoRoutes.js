// ═══════════════════════════════════════════════════════
// routes/repo.js
// Endpoints para conectar un repositorio real, listar sus
// archivos reales (leidos de disco tras el clone, no de la
// API de contenidos de GitHub archivo por archivo) y leer
// el contenido real de un archivo puntual.
// ═══════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const { getSession, createSession } = require('./sessionStore');
const git = require('./gitAgent');

const router = express.Router();

// Crea una sesion nueva (workspace propio en disco para este usuario/pestaña).
router.post('/session', (req, res) => {
  const session = createSession();
  res.json({ sessionId: session.id });
});

router.post('/repo/connect', async (req, res) => {
  const { sessionId, url, branch, token, instructions } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada. Recarga la app.' });

  const parsed = git.parseRepoUrl(url);
  if (!parsed) return res.status(400).json({ error: 'URL de repositorio invalida. Debe ser https://github.com/usuario/repo' });

  const effectiveToken = token || process.env.GITHUB_TOKEN || null;
  const effectiveBranch = branch || 'main';

  try {
    session.addLog({ type: 'run', title: `Clonando ${parsed.owner}/${parsed.repo}...` });

    const repoInfoResp = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers: {
        // GitHub exige un User-Agent en toda request a su API o responde 403.
        'User-Agent': 'DevAgent',
        Accept: 'application/vnd.github+json',
        ...(effectiveToken ? { Authorization: `token ${effectiveToken}` } : {}),
      },
    });
    if (!repoInfoResp.ok) {
      throw new Error(`No se pudo leer el repositorio en GitHub (${repoInfoResp.status}). Verifica la URL o el token.`);
    }
    const repoInfo = await repoInfoResp.json();
    const finalBranch = branch || repoInfo.default_branch || 'main';

    await git.cloneRepo({
      dir: session.dir,
      owner: parsed.owner,
      repo: parsed.repo,
      branch: finalBranch,
      token: effectiveToken,
    });

    const files = await git.listFiles(session.dir);

    session.repoFullName = repoInfo.full_name;
    session.repoUrl = url;
    session.branch = finalBranch;
    session.githubToken = effectiveToken;
    session.instructions = instructions || '';
    session.repoLanguage = repoInfo.language || null;
    session.repoDescription = repoInfo.description || '';

    session.addLog({ type: 'ok', title: `Repo clonado: ${files.length} archivos reales en disco` });

    res.json({
      repo: {
        fullName: repoInfo.full_name,
        description: repoInfo.description,
        language: repoInfo.language,
        stars: repoInfo.stargazers_count,
        private: repoInfo.private,
        branch: finalBranch,
      },
      files,
    });
  } catch (e) {
    session.addLog({ type: 'err', title: 'Error al clonar', detail: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/repo/files', (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  if (!session.repoFullName) return res.json({ files: [] });

  git.listFiles(session.dir)
    .then((files) => res.json({ files, repo: session.repoFullName, branch: session.branch }))
    .catch((e) => res.status(500).json({ error: e.message }));
});

router.get('/repo/file', async (req, res) => {
  const session = getSession(req.query.sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'Falta el parametro path' });

  try {
    const content = await git.readFile(session.dir, relPath);
    res.json({ path: relPath, content });
  } catch (e) {
    res.status(404).json({ error: `No se pudo leer ${relPath}: ${e.message}` });
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════
// routes/chat.js
// Recibe un mensaje del usuario, si hay un repo real
// clonado busca los archivos relevantes y LOS LEE DE
// VERDAD desde disco (no desde cache del navegador), arma
// el prompt, y transmite la respuesta de Groq al navegador
// en tiempo real via Server-Sent Events.
// ═══════════════════════════════════════════════════════

const express = require('express');
const { getSession } = require('./sessionStore');
const git = require('./gitAgent');
const { buildSystemPrompt, streamChat } = require('./groqClient');

const router = express.Router();

function findRelevantFiles(files, msg, limit) {
  if (!files.length) return [];
  const lower = msg.toLowerCase();

  const KEYWORD_GROUPS = {
    auth: ['auth', 'login', 'session', 'token', 'jwt', 'password'],
    db: ['database', 'db', 'model', 'schema', 'migration', 'query', 'sql', 'orm'],
    api: ['api', 'route', 'endpoint', 'controller', 'handler', 'rest', 'graphql'],
    ui: ['component', 'view', 'page', 'template', 'style', 'css', 'ui', 'layout'],
    test: ['test', 'spec', 'jest', 'mocha', 'cypress', 'vitest', 'pytest'],
    config: ['config', 'env', 'settings', 'webpack', 'vite', 'babel', 'tsconfig'],
    main: ['main', 'index', 'app', 'server', 'entry', 'start'],
  };
  const CODE_EXTS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.php', '.rb', '.cs'];
  const IMPORTANT_NAMES = ['package.json', 'requirements.txt', 'go.mod', 'index.js', 'app.js', 'main.py', 'server.js', 'main.ts', 'app.ts', 'readme.md'];

  return files
    .map((f) => {
      let score = 0;
      const p = f.toLowerCase();
      const name = p.split('/').pop().replace(/\.\w+$/, '');

      if (lower.includes(p)) score += 100;
      if (lower.includes(name)) score += 35;

      for (const words of Object.values(KEYWORD_GROUPS)) {
        if (words.some((w) => lower.includes(w)) && words.some((w) => p.includes(w))) score += 22;
      }
      if (CODE_EXTS.some((e) => p.endsWith(e))) score += 4;
      if (IMPORTANT_NAMES.includes(p.split('/').pop())) score += 12;

      return { path: f, score };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

router.post('/chat', async (req, res) => {
  const { sessionId, message, model, planMode, fileLimit } = req.body || {};
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada. Recarga la app.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  try {
    let enrichedMessage = message;
    let fileCount = 0;

    if (session.repoFullName) {
      const allFiles = await git.listFiles(session.dir);
      fileCount = allFiles.length;
      const relevant = findRelevantFiles(allFiles, message, fileLimit || 10);

      if (relevant.length) {
        send('log', { type: 'info', title: `${relevant.length} archivos relevantes encontrados`, detail: relevant.slice(0, 3).map((f) => f.path).join(', ') });

        let ctx = '';
        for (const r of relevant) {
          send('log', { type: 'run', title: `Leyendo ${r.path}` });
          try {
            const content = await git.readFile(session.dir, r.path);
            const lines = content.split('\n');
            const snippet = lines.length > 220 ? lines.slice(0, 220).join('\n') + `\n... [${lines.length - 220} lineas mas]` : content;
            ctx += `\n\n---\n### ${r.path}\n\`\`\`\n${snippet}\n\`\`\``;
            send('log', { type: 'ok', title: `Leido: ${r.path}`, detail: `${lines.length} lineas (desde disco real)` });
          } catch (e) {
            send('log', { type: 'err', title: `No se pudo leer ${r.path}`, detail: e.message });
          }
        }
        if (ctx) {
          enrichedMessage = `${message}\n\n## Contenido real de archivos relevantes (leido del clon en disco)\n${ctx}\n\n## Instruccion\nUsa el codigo de arriba para resolver la tarea con diffs quirurgicos exactos. Recuerda que estos diffs se APLICARAN de verdad sobre estos archivos.`;
        }
      } else {
        send('log', { type: 'info', title: 'Contexto general del repo', detail: `${allFiles.length} archivos disponibles` });
        enrichedMessage = `${message}\n\n## Estructura real del repo\n\`\`\`\n${allFiles.slice(0, 80).join('\n')}\n\`\`\``;
      }
    }

    const systemPrompt = buildSystemPrompt({
      repo: session.repoFullName,
      branch: session.branch,
      fileCount,
      instructions: session.instructions,
      planMode: !!planMode,
      agentCapable: !!session.repoFullName,
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(session.history || []).slice(-14),
      { role: 'user', content: enrichedMessage },
    ];

    send('log', { type: 'run', title: 'Generando respuesta...', detail: model });

    const apiKey = req.headers['x-groq-key'] || process.env.GROQ_API_KEY;
    const result = await streamChat({
      apiKey,
      model,
      messages,
      signal: abortController.signal,
      onDelta: (_delta, fullText) => send('delta', { text: fullText }),
    });

    session.history = session.history || [];
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: result });

    const diffBlocks = git.extractDiffBlocks(result);
    send('log', { type: 'ok', title: 'Completado', detail: diffBlocks.length ? `${diffBlocks.length} diff(s) propuesto(s)` : undefined });
    send('done', { text: result, diffCount: diffBlocks.length });
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') {
      send('log', { type: 'info', title: 'Detenido por el usuario' });
      send('done', { text: '', aborted: true });
    } else {
      send('log', { type: 'err', title: 'Error', detail: e.message });
      send('error', { error: e.message });
    }
    res.end();
  }
});

module.exports = router;

// ═══════════════════════════════════════════════════════
// routes/chat.js
// Recibe un mensaje del usuario, si hay un repo real
// clonado busca los archivos relevantes y LOS LEE DE
// VERDAD desde disco (no desde cache del navegador), arma
// el prompt, y transmite la respuesta del modelo local al navegador
// en tiempo real via Server-Sent Events.
// ═══════════════════════════════════════════════════════

const express = require('express');
const { getSession } = require('./sessionStore');
const git = require('./gitAgent');
const ollamaClient = require('./ollamaClient');
const groqClient  = require('./groqClient');

// Usa Groq si hay API key configurada, si no intenta con Ollama local
function getClient(reqGroqKey) {
  const key = reqGroqKey || process.env.GROQ_API_KEY;
  if (key) return { buildSystemPrompt: groqClient.buildSystemPrompt, streamChat: (opts) => groqClient.streamChat({ ...opts, apiKey: key }) };
  return { buildSystemPrompt: ollamaClient.buildSystemPrompt, streamChat: ollamaClient.streamChat };
}

const router = express.Router();

// Extrae @menciones explicitas del mensaje (ej: @server.js, @src/app.ts)
function extractMentions(message) {
  const re = /@([\w./\-]+\.\w+)/g;
  const found = new Set();
  let m;
  while ((m = re.exec(message)) !== null) found.add(m[1]);
  return [...found];
}

// Busca un archivo por nombre (parcial) dentro de la lista real del repo
function resolveFilePath(files, mention) {
  const lower = mention.toLowerCase();
  // Coincidencia exacta primero
  const exact = files.find((f) => f.toLowerCase() === lower || f.toLowerCase().endsWith('/' + lower));
  if (exact) return exact;
  // Coincidencia parcial
  return files.find((f) => f.toLowerCase().includes(lower)) || null;
}

function findRelevantFiles(files, msg, limit) {
  if (!files.length) return [];
  const lower = msg.toLowerCase();

  const KEYWORD_GROUPS = {
    auth: ['auth', 'login', 'session', 'token', 'jwt', 'password', 'oauth'],
    db: ['database', 'db', 'model', 'schema', 'migration', 'query', 'sql', 'orm', 'prisma', 'mongoose'],
    api: ['api', 'route', 'endpoint', 'controller', 'handler', 'rest', 'graphql', 'webhook'],
    ui: ['component', 'view', 'page', 'template', 'style', 'css', 'ui', 'layout', 'modal', 'button'],
    test: ['test', 'spec', 'jest', 'mocha', 'cypress', 'vitest', 'pytest', 'unit', 'e2e'],
    config: ['config', 'env', 'settings', 'webpack', 'vite', 'babel', 'tsconfig', 'eslint'],
    main: ['main', 'index', 'app', 'server', 'entry', 'start', 'init'],
    types: ['type', 'interface', 'enum', 'dto', 'schema', 'zod', 'yup'],
    utils: ['util', 'helper', 'lib', 'hook', 'service', 'store', 'context'],
  };
  const CODE_EXTS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.php', '.rb', '.cs', '.vue', '.svelte'];
  const IMPORTANT_NAMES = ['package.json', 'requirements.txt', 'go.mod', 'index.js', 'app.js', 'main.py', 'server.js', 'main.ts', 'app.ts', 'readme.md', 'dockerfile', 'docker-compose.yml'];

  return files
    .map((f) => {
      let score = 0;
      const p = f.toLowerCase();
      const name = p.split('/').pop().replace(/\.\w+$/, '');

      if (lower.includes(p)) score += 120;
      if (lower.includes(name)) score += 40;

      for (const [group, words] of Object.entries(KEYWORD_GROUPS)) {
        const msgMatch = words.some((w) => lower.includes(w));
        const fileMatch = words.some((w) => p.includes(w));
        if (msgMatch && fileMatch) score += 25;
        else if (fileMatch && group === 'main') score += 8; // entry points always useful
      }
      if (CODE_EXTS.some((e) => p.endsWith(e))) score += 5;
      if (IMPORTANT_NAMES.some((n) => p.endsWith(n))) score += 15;

      return { path: f, score };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

router.post('/chat', async (req, res) => {
  const { sessionId, message, model, planMode, fileLimit, groqApiKey } = req.body || {};
  const { buildSystemPrompt, streamChat } = getClient(groqApiKey);
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

      // 1. Resolver @menciones explicitas (maxima prioridad)
      const mentions = extractMentions(message);
      const mentionedPaths = [];
      for (const m of mentions) {
        const resolved = resolveFilePath(allFiles, m);
        if (resolved && !mentionedPaths.includes(resolved)) mentionedPaths.push(resolved);
      }

      // 2. Completar con archivos relevantes por heuristica
      const heuristicLimit = Math.max(0, (fileLimit || 10) - mentionedPaths.length);
      const heuristic = findRelevantFiles(
        allFiles.filter((f) => !mentionedPaths.includes(f)),
        message,
        heuristicLimit,
      );

      const toRead = [
        ...mentionedPaths.map((p) => ({ path: p, explicit: true })),
        ...heuristic.map((r) => ({ path: r.path, explicit: false })),
      ];

      if (toRead.length) {
        const labels = toRead.slice(0, 3).map((r) => (r.explicit ? `@${r.path.split('/').pop()}` : r.path)).join(', ');
        send('log', { type: 'info', title: `Leyendo ${toRead.length} archivo(s)`, detail: labels });

        let ctx = '';
        for (const r of toRead) {
          send('log', { type: 'run', title: r.explicit ? `@${r.path.split('/').pop()} (mencionado)` : `Leyendo ${r.path}` });
          try {
            const content = await git.readFile(session.dir, r.path);
            const lines = content.split('\n');
            // Archivos @mencionados: hasta 400 lineas. Heuristicos: hasta 200.
            const cap = r.explicit ? 400 : 220;
            const snippet = lines.length > cap
              ? lines.slice(0, cap).join('\n') + `\n... [${lines.length - cap} lineas mas]`
              : content;
            ctx += `\n\n---\n### ${r.path}${r.explicit ? ' ← mencionado con @' : ''}\n\`\`\`\n${snippet}\n\`\`\``;
            send('log', { type: 'ok', title: `Leido: ${r.path}`, detail: `${lines.length} lineas` });
          } catch (e) {
            send('log', { type: 'err', title: `No se pudo leer ${r.path}`, detail: e.message });
          }
        }
        if (ctx) {
          enrichedMessage = `${message}\n\n## Archivos del repositorio (contenido real leido de disco)\n${ctx}\n\n## Instruccion critica\nUsa el codigo de arriba. Genera diffs unified-format exactos y quirurgicos. Estos diffs se APLICARAN de verdad sobre los archivos reales.`;
        }
      } else {
        send('log', { type: 'info', title: 'Contexto general del repo', detail: `${allFiles.length} archivos` });
        enrichedMessage = `${message}\n\n## Estructura del repositorio\n\`\`\`\n${allFiles.slice(0, 100).join('\n')}\n\`\`\`\n\nSi necesitas ver un archivo especifico, dime su nombre o mencionalo con @.`;
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

    send('log', { type: 'run', title: 'Generando respuesta...', detail: 'modelo local' });

    const result = await streamChat({
      model,   // ignorado si no coincide — ollamaClient usa DEFAULT_MODEL
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

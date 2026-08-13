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
const openrouter = require('./openrouterClient');
const groq = require('./groqClient');
const ollama = require('./ollamaClient');
const { runCommand, extractAutomaticCommands } = require('./commandRunner');
const { extractToolCommands } = require('./toolCommands');
const tools = require('./toolsClient');

const router = express.Router();
const MAX_AUTOMATIC_ROUNDS = 4;
const MAX_COMMANDS_PER_ROUND = 5;
const MAX_COMMAND_CONTEXT_BYTES = 30_000;

// Prioridad de proveedor: Groq primero si hay clave (API paga/con capa
// gratuita real, rapida y con IDs de modelo estables — no se deslistan
// como el catalogo ":free" de OpenRouter), despues OpenRouter (modelos
// gratuitos, catalogo consultado en vivo), y por ultimo Ollama local para
// entornos sin ninguna clave configurada.
function pickAiClient() {
  if (process.env.GROQ_API_KEY) return groq;
  if (process.env.OPENROUTER_API_KEY) return openrouter;
  return ollama;
}
const aiClient = pickAiClient();

function truncateCommandOutput(value) {
  const text = String(value || '');
  if (text.length <= MAX_COMMAND_CONTEXT_BYTES) return text;
  return `${text.slice(0, MAX_COMMAND_CONTEXT_BYTES)}\n...[salida recortada]`;
}

function commandResultForModel(command, result) {
  const stdout = truncateCommandOutput(result.stdout);
  const stderr = truncateCommandOutput(result.stderr);
  const sections = [
    `### ${command.display}`,
    `Estado: ${result.ok ? 'completado' : 'falló'} (código ${result.code ?? 'desconocido'})`,
  ];
  if (stdout) sections.push(`stdout:\n\`\`\`\n${stdout}\n\`\`\``);
  if (stderr) sections.push(`stderr:\n\`\`\`\n${stderr}\n\`\`\``);
  if (result.error && !stderr.includes(result.error)) sections.push(`error: ${result.error}`);
  return sections.join('\n');
}

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

function projectProfile(files) {
  const lower = files.map((file) => file.toLowerCase());
  const languages = [
    ['JavaScript/Node.js', ['.js', '.cjs', '.mjs', 'package.json']],
    ['TypeScript', ['.ts', '.tsx', 'tsconfig.json']],
    ['Python', ['.py', 'requirements.txt', 'pyproject.toml', 'setup.py']],
    ['Go', ['.go', 'go.mod']],
    ['Rust', ['.rs', 'cargo.toml']],
    ['Java/Kotlin', ['.java', '.kt', 'pom.xml', 'build.gradle']],
  ];
  const detected = languages
    .filter(([, markers]) => markers.some((marker) => lower.some((file) => file.endsWith(marker) || file.includes(marker))))
    .map(([name]) => name);
  const tests = files.filter((file) => /(^|\/)(__tests__|tests?|spec)(\/|\.|$)/i.test(file)).slice(0, 20);
  const entrypoints = files.filter((file) => /(^|\/)(index|main|app|server)\.(js|ts|jsx|tsx|py|go|rs)$/i.test(file)).slice(0, 20);
  return [
    `Lenguajes detectados: ${detected.length ? detected.join(', ') : 'no determinado'}`,
    `Archivos de pruebas detectados: ${tests.length ? tests.join(', ') : 'ninguno evidente'}`,
    `Puntos de entrada probables: ${entrypoints.length ? entrypoints.join(', ') : 'ninguno evidente'}`,
    `Estructura (primeros ${Math.min(files.length, 160)} archivos):`,
    files.slice(0, 160).join('\n'),
  ].join('\n');
}

async function readProjectProfile(dir, files) {
  const candidates = files.filter((file) => /(^|\/)(readme(?:\.[^/]+)?|package\.json|pyproject\.toml|requirements(?:[-._].*)?\.txt|setup\.py|go\.mod|cargo\.toml|dockerfile|compose\.ya?ml|\.env\.example)$/i.test(file)).slice(0, 8);
  const sections = [];
  for (const file of candidates) {
    try {
      const content = await git.readFile(dir, file);
      sections.push(`--- ${file}\n${content.split('\n').slice(0, 260).join('\n')}`);
    } catch {
      // Un archivo puede desaparecer mientras el repositorio cambia; el mapa
      // estructural sigue siendo útil aunque falte un manifiesto.
    }
  }
  return sections.join('\n\n');
}

// Ejecuta una herramienta ("Buscar:", "Wikipedia:", "Generar video:",
// "Editar imagen:") pedida por el modelo, emitiendo pasos en vivo por
// send('log', ...) para que el usuario vea en tiempo real qué está
// pasando (qué página se visita, en qué clip de video va, etc), y
// devuelve un bloque de texto con el resultado real para inyectarlo
// de vuelta en la conversación.
async function runToolCommand(command, send, session) {
  const onStep = (step) => {
    switch (step.type) {
      case 'search_start':
        send('log', { type: 'run', title: `Buscando en internet: "${step.query}"` });
        send('computer', { mode: 'browser', action: 'search', engine: 'web', query: step.query });
        break;
      case 'search_visit':
        send('log', { type: 'info', title: `Visitando: ${new URL(step.url).hostname}`, detail: step.title });
        send('computer', { mode: 'browser', action: 'visit', url: step.url, title: step.title, snippet: step.snippet });
        break;
      case 'search_done':
        send('log', { type: 'ok', title: `Búsqueda completada`, detail: `${step.count} resultado(s)` });
        send('computer', { mode: 'browser', action: 'search_done', count: step.count });
        break;
      case 'wiki_start':
        send('log', { type: 'run', title: `Consultando Wikipedia: "${step.query}"` });
        send('computer', { mode: 'browser', action: 'search', engine: 'wikipedia', query: step.query });
        break;
      case 'wiki_visit':
        send('log', { type: 'info', title: `Artículo encontrado: ${step.title}` });
        send('computer', { mode: 'browser', action: 'visit', url: `https://es.wikipedia.org/wiki/${encodeURIComponent(step.title.replace(/ /g, '_'))}`, title: step.title, snippet: 'Abriendo artículo…' });
        break;
      case 'wiki_done':
        send('log', { type: step.found ? 'ok' : 'err', title: step.found ? 'Wikipedia consultada' : 'No se encontró artículo' });
        if (step.found) send('computer', { mode: 'browser', action: 'visit', url: step.url, title: step.title, snippet: step.extract });
        else send('computer', { mode: 'browser', action: 'search_done', count: 0 });
        break;
      case 'video_start':
        send('log', { type: 'run', title: `Generando video (${step.targetSeconds}s)`, detail: `${step.remainingToday} video(s) restantes hoy` });
        send('computer', { mode: 'terminal', action: 'run', command: `generar-video --duracion ${step.targetSeconds}s` });
        break;
      case 'video_clip_start':
        send('log', { type: 'run', title: `Clip ${step.clipIndex}: generando ${step.clipDuration}s` });
        send('computer', { mode: 'terminal', action: 'output', text: `[clip ${step.clipIndex}] generando ${step.clipDuration}s…`, ok: true });
        break;
      case 'video_clip_progress':
        send('log', { type: 'info', title: `Clip ${step.clipIndex}: ${step.status}` });
        send('computer', { mode: 'terminal', action: 'output', text: `[clip ${step.clipIndex}] estado: ${step.status}`, ok: true });
        break;
      case 'video_clip_ready':
        send('log', { type: 'ok', title: `Clip ${step.clipIndex} listo`, detail: step.url });
        send('computer', { mode: 'terminal', action: 'output', text: `[clip ${step.clipIndex}] listo → ${step.url}`, ok: true });
        break;
      case 'video_done':
        send('log', { type: 'ok', title: 'Video completo', detail: `${step.clips} clip(s), ${step.totalSeconds}s totales` });
        send('computer', { mode: 'terminal', action: 'done', text: `Video completo: ${step.clips} clip(s), ${step.totalSeconds}s totales`, ok: true });
        break;
      case 'image_edit_start':
        send('log', { type: 'run', title: 'Editando imagen con IA', detail: step.instruction });
        send('computer', { mode: 'terminal', action: 'run', command: `editar-imagen "${step.instruction}"` });
        break;
      case 'image_edit_done':
        send('log', { type: step.hasImage ? 'ok' : 'err', title: step.hasImage ? 'Imagen editada' : 'No se pudo generar la imagen' });
        send('computer', { mode: 'terminal', action: 'done', text: step.hasImage ? 'Imagen editada correctamente' : 'No se pudo generar la imagen', ok: step.hasImage });
        break;
      case 'batch_item_start':
        send('log', { type: 'run', title: `Editando imagen ${step.index + 1}/${step.total}` });
        send('computer', { mode: 'terminal', action: 'output', text: `[imagen ${step.index + 1}/${step.total}] procesando…`, ok: true });
        break;
      case 'batch_item_done':
        send('log', { type: 'ok', title: `Imagen ${step.index + 1}/${step.total} lista` });
        send('computer', { mode: 'terminal', action: 'output', text: `[imagen ${step.index + 1}/${step.total}] lista`, ok: true });
        break;
    }
  };

  try {
    if (command.tool === 'search') {
      const result = await tools.webSearch({ query: command.query, onStep });
      const lines = result.results.map((r, i) => `${i + 1}. **${r.title}** — ${r.url}\n   ${r.snippet}`).join('\n\n');
      return `### Resultado de búsqueda web: "${command.query}"\n${result.answer ? `Respuesta directa: ${result.answer}\n\n` : ''}${lines || 'Sin resultados.'}`;
    }
    if (command.tool === 'wikipedia') {
      const result = await tools.wikipediaLookup({ query: command.query, onStep });
      if (!result.found) return `### Wikipedia: "${command.query}"\nNo se encontró ningún artículo relevante.`;
      return `### Wikipedia: ${result.title}\n${result.extract}\n\nFuente: ${result.url}`;
    }
    if (command.tool === 'video') {
      const result = await tools.generateVideo({ prompt: command.prompt, durationSec: command.durationSec, onStep });
      const clipList = result.clips.map((c) => `- Clip ${c.index} (${c.seconds}s): ${c.url}`).join('\n');
      return `### Video generado: "${command.prompt}"\nDuración total: ${result.totalSeconds}s en ${result.clips.length} clip(s)\n${clipList}\nVideos restantes hoy: ${result.remainingToday}`;
    }
    if (command.tool === 'image') {
      const result = await tools.editImage({ imageUrl: command.imageUrl, instruction: command.instruction, onStep });
      return `### Imagen editada\nInstrucción: ${command.instruction}\n${result.imageUrl ? `Resultado: ${result.imageUrl}` : 'No se pudo generar la imagen editada.'}${result.note ? `\nNota: ${result.note}` : ''}`;
    }
  } catch (e) {
    send('log', { type: 'err', title: `Error en herramienta (${command.tool})`, detail: e.message });
    return `### Error ejecutando herramienta "${command.tool}"\n${e.message}`;
  }
  return '';
}

function summarizeDiffResults(results) {
  return results.map((result) => {
    const state = result.applied
      ? `aplicado automáticamente (${result.bytes} bytes)`
      : result.alreadyApplied
      ? 'ya estaba aplicado'
      : `no aplicado: ${result.reason}`;
    return `- ${result.path || '(sin archivo)'}: ${state}`;
  }).join('\n');
}

router.post('/chat', async (req, res) => {
  const { sessionId, message, model, planMode, fileLimit, autoApply = true } = req.body || {};
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
      const profile = projectProfile(allFiles);
      const manifestContext = await readProjectProfile(session.dir, allFiles);
      send('log', { type: 'info', title: 'Perfil del proyecto listo', detail: `${fileCount} archivos · ${manifestContext ? 'manifiestos leídos' : 'sin manifiestos principales'}` });
      send('computer', { mode: 'files', action: 'listing', path: session.repoFullName, count: fileCount });

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
          send('computer', { mode: 'files', action: 'open', path: r.path });
          try {
            const content = await git.readFile(session.dir, r.path);
            const lines = content.split('\n');
            // Un diff solo puede aplicarse si el modelo vio el texto real.
            // Los archivos mencionados explícitamente se envían completos
            // (hasta un límite amplio); truncarlos era la causa principal de
            // diffs que no coincidían con el archivo en disco.
            // El cap bajo (220) para archivos no mencionados explicitamente
            // era una causa frecuente de diffs invalidos: el modelo generaba
            // un parche contra un archivo que solo vio truncado, y el hunk
            // no calzaba contra el contenido real completo. Se sube a 600,
            // que cubre la gran mayoria de archivos de codigo reales sin
            // disparar el limite de contexto del modelo.
            const cap = r.explicit ? 4000 : 600;
            const snippet = lines.length > cap
              ? lines.slice(0, cap).join('\n') + `\n... [archivo truncado: ${lines.length - cap} lineas mas; no generes diffs para las lineas no mostradas]`
              : content;
            ctx += `\n\n---\n### ${r.path}${r.explicit ? ' ← mencionado con @' : ''}\n\`\`\`\n${snippet}\n\`\`\``;
            send('log', { type: 'ok', title: `Leido: ${r.path}`, detail: `${lines.length} lineas` });
            send('computer', { mode: 'files', action: 'read', path: r.path, lines: lines.length, preview: lines.slice(0, 24).join('\n') });
          } catch (e) {
            send('log', { type: 'err', title: `No se pudo leer ${r.path}`, detail: e.message });
            send('computer', { mode: 'files', action: 'error', path: r.path, text: e.message });
          }
        }
        if (ctx) {
           enrichedMessage = `${message}\n\n## Perfil estructural del repositorio\n${profile}\n\n## Manifiestos y documentación principal (contenido real)\n${manifestContext || '(no se encontraron manifiestos principales)'}\n\n## Archivos del repositorio (contenido real leido de disco)\n${ctx}\n\n## Instruccion critica\nUsa el codigo de arriba. Este contenido es la version mas reciente leida directamente del disco y tiene prioridad sobre cualquier archivo, diff o suposicion de mensajes anteriores. Genera diffs unified-format exactos y quirurgicos solo contra esta version. Los cambios seguros se aplican y se verifican automáticamente; no le pidas al usuario que copie, aplique o ejecute nada.`;
        }
      } else {
        send('log', { type: 'info', title: 'Contexto general del repo', detail: `${allFiles.length} archivos` });
        enrichedMessage = `${message}\n\n## Estructura del repositorio\n\`\`\`\n${allFiles.slice(0, 100).join('\n')}\n\`\`\`\n\nSi necesitas ver un archivo especifico, dime su nombre o mencionalo con @.`;
      }
    }

    const systemPrompt = aiClient.buildSystemPrompt({
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

    let result = await aiClient.streamChat({
      model,   // ignorado si no coincide — ollamaClient usa DEFAULT_MODEL
      messages,
      signal: abortController.signal,
      onDelta: (_delta, fullText) => send('delta', { text: fullText }),
    });

    // La IA puede pedir comandos de inspección o validación en una línea
    // "Ejecuta: ...". Los ejecutamos aquí, en el workspace de la sesión, y
    // devolvemos el resultado a la IA para que continúe sin intervención.
    const conversation = [...messages];
    const seenCommands = new Set();
    let visibleResult = result;

    const seenDiffs = new Set();
    let autoAppliedPaths = [];
    // Registro de CADA bloque de diff que el backend ya proceso (aplicado
    // o no) durante este turno, junto con su texto crudo. El frontend lo
    // usa para no repintar un boton "Aplicar" activo sobre un diff que el
    // propio servidor ya aplico via autoApply — pulsarlo de nuevo siempre
    // fallaba ("el diff no coincide", porque el archivo ya cambio), que
    // era la fuente mas comun de "error al aplicar cambios" reportada.
    const appliedDiffs = [];
    const seenToolCommands = new Set();
    for (let round = 0; round < MAX_AUTOMATIC_ROUNDS; round += 1) {
      const requested = extractAutomaticCommands(result);
      const commands = requested
        .filter((command) => {
          const key = `${command.binary}\u0000${command.args.join('\u0000')}`;
          if (seenCommands.has(key)) return false;
          seenCommands.add(key);
          return true;
        })
        .slice(0, MAX_COMMANDS_PER_ROUND);

      const requestedTools = extractToolCommands(result).filter((c) => {
        const key = JSON.stringify(c);
        if (seenToolCommands.has(key)) return false;
        seenToolCommands.add(key);
        return true;
      });

      const commandResults = [];
      const diffResults = [];
      const toolResults = [];
      if (autoApply && session.repoFullName) {
        const diffBlocks = git.extractDiffBlocks(result);
        for (const diffBlock of diffBlocks) {
          const diffKey = diffBlock.trim();
          if (!diffKey || seenDiffs.has(diffKey)) continue;
          seenDiffs.add(diffKey);
          const results = await git.applyUnifiedDiff(session.dir, diffBlock);
          diffResults.push(...results);
          appliedDiffs.push({
            diff: diffKey,
            applied: results.every((r) => r.applied),
            paths: results.map((r) => r.path).filter(Boolean),
            reason: results.find((r) => !r.applied)?.reason || null,
            alreadyApplied: results.some((r) => r.alreadyApplied),
          });
          for (const applied of results) {
            const event = applied.applied
              ? { type: 'ok', title: `Cambio aplicado automáticamente: ${applied.path}`, detail: `${applied.bytes} bytes escritos y listos para verificar` }
              : { type: applied.alreadyApplied ? 'info' : 'err', title: applied.alreadyApplied ? `Cambio ya aplicado: ${applied.path}` : `Cambio no aplicado: ${applied.path || 'diff'}`, detail: applied.reason };
            send('log', event);
            send('computer', { mode: 'files', action: applied.applied ? 'write' : 'write_failed', path: applied.path, bytes: applied.bytes, text: applied.reason });
            session.addLog(event);
            if (applied.applied && applied.path && !autoAppliedPaths.includes(applied.path)) autoAppliedPaths.push(applied.path);
          }
        }
      }

      if (!commands.length && !diffResults.length && !requestedTools.length) break;

      for (const toolCommand of requestedTools) {
        const toolText = await runToolCommand(toolCommand, send, session);
        if (toolText) toolResults.push(toolText);
      }

      for (const command of commands) {
        const title = `Ejecutando automáticamente: ${command.display}`;
        send('log', { type: 'run', title });
        send('computer', { mode: 'terminal', action: 'run', command: command.display });
        session.addLog({ type: 'run', title });

        const commandResult = await runCommand(command.binary, command.args, session.dir);
        commandResults.push(commandResultForModel(command, commandResult));

        const output = truncateCommandOutput(commandResult.stdout || commandResult.stderr || commandResult.error);
        const logEntry = {
          type: commandResult.ok ? 'ok' : 'err',
          title: commandResult.ok ? `Completado: ${command.display}` : `Falló: ${command.display}`,
          detail: output,
        };
        send('log', logEntry);
        send('computer', { mode: 'terminal', action: 'output', text: output || (commandResult.ok ? '(sin salida)' : 'error'), ok: commandResult.ok });
        session.addLog(logEntry);
      }

      conversation.push({ role: 'assistant', content: result });
      conversation.push({
        role: 'user',
        content: [
          commandResults.length ? `## Resultados de comandos ejecutados automáticamente\n${commandResults.join('\n\n')}` : '',
          diffResults.length ? `## Cambios procesados automáticamente\n${summarizeDiffResults(diffResults)}` : '',
          toolResults.length ? `## Resultados de herramientas ejecutadas automáticamente (ya mostrados al usuario tal cual, NO los repitas ni los reformatees)\n${toolResults.join('\n\n')}` : '',
          '',
          'Continúa trabajando con estos resultados. No le pidas al usuario que copie, aplique o ejecute nada: el sistema ya realizó la acción. Si se usó una herramienta (búsqueda, Wikipedia, video o imagen), su resultado YA se mostró al usuario en una tarjeta visual — no repitas las URLs ni el bloque "###"; solo agrega, si aporta, un comentario breve interpretando o resumiendo ese resultado. Verifica los cambios de código con pruebas o comprobaciones apropiadas. Si algo falla, corrígelo con otro diff exacto y vuelve a verificar. Si ya está todo correcto, responde con un resumen claro.',
        ].join('\n'),
      });

      // Los resultados reales de herramientas (búsqueda/wikipedia/video/
      // imagen) se anexan tal cual al texto visible ANTES de pedirle a la
      // IA que continúe. Así la tarjeta siempre se renderiza con datos
      // reales del servidor, nunca depende de que el modelo los copie
      // bien — solo se le pide un comentario adicional, no que reescriba
      // el bloque.
      if (toolResults.length) {
        visibleResult = `${visibleResult}\n\n${toolResults.join('\n\n')}`;
        send('delta', { text: visibleResult });
      }

      const previous = visibleResult;
      result = await aiClient.streamChat({
        model,
        messages: conversation,
        signal: abortController.signal,
        onDelta: (_delta, fullText) => send('delta', { text: `${previous}\n\n${fullText}` }),
      });
      visibleResult = `${previous}\n\n${result}`;
    }

    if (visibleResult !== result) result = visibleResult;

    session.history = session.history || [];
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: result });

    const diffBlocks = git.extractDiffBlocks(result);
    send('log', { type: 'ok', title: 'Completado', detail: diffBlocks.length ? `${diffBlocks.length} diff(s) propuesto(s)` : undefined });
    send('done', { text: result, diffCount: diffBlocks.length, autoAppliedPaths, appliedDiffs });
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

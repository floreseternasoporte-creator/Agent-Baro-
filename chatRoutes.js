// ═══════════════════════════════════════════════════════
// routes/chat.js
// Recibe un mensaje del usuario, si hay un repo real
// clonado busca los archivos relevantes y LOS LEE DE
// VERDAD desde disco (no desde cache del navegador), arma
// el prompt, y transmite la respuesta del modelo local al navegador
// en tiempo real via Server-Sent Events.
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getOwnedSession } = require('./sessionStore');
const jobsStore = require('./jobsStore');
const threadsStore = require('./threadsStore');
const git = require('./gitAgent');
const groq = require('./groqClient');
const ollama = require('./ollamaClient');
const { runCommand, extractAutomaticCommands, isSafeWorkspaceArgument } = require('./commandRunner');
const { extractToolCommands } = require('./toolCommands');
const { BARO_TOOLS, toolCallToCommand } = require('./toolsCatalog');
const tools = require('./toolsClient');
const { runComputerTask } = require('./computerTask');
const { loadAgentsInstructions } = require('./agentsMd');

const router = express.Router();
// Rondas automáticas por turno: el modelo puede pedir herramientas,
// diffs y comandos en cadena y el sistema los ejecuta y le devuelve
// los resultados para que continúe. 12 rondas sostienen tareas de
// horizonte largo (investigar → editar → revisar → probar →
// corregir) sin cortar el flujo a la mitad. Los topes por ronda
// (5 comandos, diffs deduplicados) evitan loops infinitos.
const MAX_AUTOMATIC_ROUNDS = 12;
const MAX_COMMANDS_PER_ROUND = 5;
const MAX_COMMAND_CONTEXT_BYTES = 30_000;
const PLAN_MODE_READ_ONLY_TOOLS = new Set(['search', 'wikipedia', 'deep-research', 'code-review']);

// Mutex simple en memoria: encadena los turnos de una misma
// sesión para que dos POST /chat simultáneos no se pisen el
// historial, las notas ni los archivos del workspace.
const chatTurnChains = new Map();

function safeUrlHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname || 'fuente web';
  } catch {
    return 'fuente web';
  }
}

// ── Cadena de proveedores con FAILOVER AUTOMATICO ──────────
// Stack 100% GRATUITO (2026-09-27, v3 brutal sin OpenRouter):
//   1. Groq → Llama 3.3 70B (gratis con GROQ_API_KEY, rápido).
//   2. Pollinations → GRATIS y SIN CLAVE, siempre disponible.
//   3. Ollama local.
// El chat NUNCA muere por falta de claves: sin GROQ_API_KEY
// responde igual con Pollinations. Se resuelve EN CADA REQUEST
// (no al arrancar), así que agregar una key no requiere
// reiniciar el servidor.
const pollinations = require('./pollinationsClient');

function providerChain() {
  const chain = [];
  if (process.env.GROQ_API_KEY) chain.push({ name: 'Groq', client: groq });
  chain.push({ name: 'Pollinations (gratis)', client: pollinations });
  chain.push({ name: 'Ollama local', client: ollama });
  return chain;
}

/**
 * Intenta cada proveedor en orden hasta que uno entregue el stream.
 * Si un proveedor falla ANTES de emitir el primer token, se pasa al
 * siguiente de forma transparente. Si falla a mitad del stream, se
 * propaga el error (no hay failover limpio a mitad de respuesta).
 */
const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

async function streamWithFailover({ model, messages, signal, onDelta, onProvider }) {
  let lastError = null;
  for (const { name, client } of providerChain()) {
    // Los proveedores gratuitos devuelven vacío o 429 de forma
    // intermitente: reintentos con pausa antes de bajar de
    // proveedor rescatan la mayoría de esos turnos. Pollinations
    // (pool anónimo con nodos desiguales) recibe un intento extra
    // y pausas más largas.
    const maxAttempts = name.startsWith('Pollinations') ? 3 : 2;
    const retryDelays = name.startsWith('Pollinations') ? [2000, 6000] : [1500, 1500];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let started = false;
      try {
        const result = await client.streamChat({
          model,
          messages,
          signal,
          onDelta: (delta, fullText) => {
            if (!delta) return;
            if (!started) { started = true; onProvider?.(name); }
            onDelta(delta, fullText);
          },
        });
        // Un stream que termina sin error pero VACÍO no es un éxito:
        // se prueba el siguiente proveedor en vez de entregar un
        // turno en blanco al usuario.
        if (!(result && String(result).trim())) {
          lastError = new Error(`${name} devolvió una respuesta vacía`);
          console.error(`[baro] proveedor ${name} devolvió vacío (intento ${attempt + 1}), ${attempt < maxAttempts - 1 ? 'reintentando' : 'probando siguiente'}`);
          if (attempt < maxAttempts - 1) { await sleepAbortable(retryDelays[attempt] || 1500, signal); continue; }
          break;
        }
        return result;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastError = e;
        if (started) throw e;
        console.error(`[baro] proveedor ${name} fallo (intento ${attempt + 1}), probando siguiente:`, e.message);
        if (attempt < maxAttempts - 1 && (e.status === 429 || e.status >= 500 || !e.status)) { await sleepAbortable(retryDelays[attempt] || 1500, signal); continue; }
        break;
      }
    }
  }
  const err = new Error(lastError ? `No se pudo responder. Último error: ${lastError.message}` : 'Servicio no disponible');
  err.status = lastError?.status || 503;
  throw err;
}

/**
 * Igual que streamWithFailover, pero con HERRAMIENTAS NATIVAS (H1):
 * llama a client.streamChatWithTools cuando existe y devuelve
 * { text, toolCalls, toolsSupported, provider }. Si el cliente no
 * tiene streamChatWithTools, degrada a streamChat y marca
 * toolsSupported:false (el turno usa el protocolo de texto).
 * Una respuesta con SOLO tool_calls y texto vacío es un éxito.
 */
async function streamWithFailoverTools({ model, messages, tools, signal, onDelta, onProvider }) {
  let lastError = null;
  for (const { name, client } of providerChain()) {
    const maxAttempts = name.startsWith('Pollinations') ? 3 : 2;
    const retryDelays = name.startsWith('Pollinations') ? [2000, 6000] : [1500, 1500];
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let started = false;
      try {
        const call = typeof client.streamChatWithTools === 'function'
          ? await client.streamChatWithTools({
              model,
              messages,
              tools,
              signal,
              onDelta: (delta, fullText) => {
                if (!delta) return;
                if (!started) { started = true; onProvider?.(name); }
                onDelta(delta, fullText);
              },
            })
          : await (async () => {
              const text = await client.streamChat({
                model,
                messages,
                signal,
                onDelta: (delta, fullText) => {
                  if (!delta) return;
                  if (!started) { started = true; onProvider?.(name); }
                  onDelta(delta, fullText);
                },
              });
              return { text, toolCalls: [], finishReason: null, toolsSupported: false };
            })();
        const text = call.text || '';
        const toolCalls = Array.isArray(call.toolCalls) ? call.toolCalls : [];
        if (!text.trim() && !toolCalls.length) {
          lastError = new Error(`${name} devolvió una respuesta vacía`);
          console.error(`[baro] proveedor ${name} devolvió vacío (intento ${attempt + 1}), ${attempt < maxAttempts - 1 ? 'reintentando' : 'probando siguiente'}`);
          if (attempt < maxAttempts - 1) { await sleepAbortable(retryDelays[attempt] || 1500, signal); continue; }
          break;
        }
        return { text, toolCalls, toolsSupported: call.toolsSupported !== false, provider: name };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastError = e;
        if (started) throw e;
        console.error(`[baro] proveedor ${name} fallo (intento ${attempt + 1}), probando siguiente:`, e.message);
        if (attempt < maxAttempts - 1 && (e.status === 429 || e.status >= 500 || !e.status)) { await sleepAbortable(retryDelays[attempt] || 1500, signal); continue; }
        break;
      }
    }
  }
  const err = new Error(lastError ? `No se pudo responder. Último error: ${lastError.message}` : 'Servicio no disponible');
  err.status = lastError?.status || 503;
  throw err;
}

/**
 * Generación de texto SIN streaming por la misma cadena de
 * proveedores (para tareas internas: redactar documentos,
 * resumir historial). Devuelve el texto completo.
 */
async function generateText(prompt, signal) {
  let lastError = null;
  for (const { name, client } of providerChain()) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await client.streamChat({
          messages: [{ role: 'user', content: prompt }],
          signal,
        });
        if (text && text.trim()) return text;
        lastError = new Error(`${name} devolvió vacío`);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastError = e;
      }
      if (attempt === 0) { try { await sleepAbortable(1200, signal); } catch { throw lastError; } }
    }
  }
  throw new Error(`Ningún servicio pudo generar texto: ${lastError?.message || 'desconocido'}`);
}

/**
 * Auto-review estilo Codex: antes de aplicar un diff, un segundo
 * pase del modelo actúa como revisor senior. Es FAIL-CLOSED: si
 * lo rechaza, si su respuesta no trae un veredicto parseable o
 * si el propio revisor falla, el diff NO se auto-aplica; queda
 * como diff normal para aplicación manual.
 * Devuelve { approved: boolean, reason: string, unclear?: boolean }.
 */
async function reviewDiffWithAI(diffBlock, generateTextFn) {
  const verdict = await generateTextFn(
    'Actúa como revisor de código senior, estricto pero justo. Analiza el siguiente diff unificado.\n' +
    'Responde EXACTAMENTE en este formato (dos líneas):\n' +
    'VEREDICTO: SI o NO\n' +
    'MOTIVO: <una sola línea>\n\n' +
    'Aprueba (SI) solo si el diff es sintácticamente válido, los paths parecen correctos y el cambio es seguro y coherente con lo que pretende. ' +
    'Rechaza (NO) si ves errores de sintaxis, paths que no existen, cambios destructivos sin justificación, o secretos/credenciales hardcodeados.\n\n' +
    '```diff\n' + diffBlock.slice(0, 6000) + '\n```'
  );
  const m = /VEREDICTO:\s*(S[IÍ]|NO)/i.exec(verdict || '');
  const reasonM = /MOTIVO:\s*(.+)/i.exec(verdict || '');
  const reason = (reasonM ? reasonM[1] : 'sin motivo').trim().slice(0, 300);
  if (!m) {
    return {
      approved: false,
      unclear: true,
      reason: 'Revisión sin veredicto claro: no aplicado automáticamente',
    };
  }
  return { approved: m[1].toUpperCase().startsWith('S'), reason };
}

/**
 * Pipeline de UN bloque diff (auto-review -> aplicar). Lo usan igual
 * la vía de texto (bloque ```diff) y la vía nativa (tool apply_diff):
 * mismo veredicto, mismos logs, mismo registro en appliedDiffs.
 * Devuelve las entradas para diffResults (strings de rechazo o los
 * objetos {applied, path, ...} de applyUnifiedDiff).
 */
async function processDiffBlock({ diffBlock, session, send, signal, autoAppliedPaths, appliedDiffs }) {
  const results = [];
  send('log', { type: 'run', title: 'Revisando el cambio antes de aplicarlo…' });
  let review = { approved: false, unclear: true, reason: 'Revisión sin veredicto claro: no aplicado automáticamente' };
  try {
    review = await reviewDiffWithAI(diffBlock, (p) => generateText(p, signal));
  } catch (e) {
    review = {
      approved: false,
      unclear: true,
      reason: `Revisión sin veredicto claro: no aplicado automáticamente (revisor no disponible: ${e.message})`,
    };
  }
  if (!review.approved) {
    if (review.unclear) {
      send('log', {
        type: 'info',
        title: 'Revisión sin veredicto claro: no aplicado automáticamente',
        detail: review.reason,
      });
      session.addLog({ type: 'info', title: 'Cambio no aplicado por revisión sin veredicto claro', detail: review.reason });
      results.push(`### Cambio NO aplicado por revisión sin veredicto claro\n${review.reason}. El cambio queda disponible como propuesta para aplicarlo cuando quieras; no afirmes que fue aplicado.\n\`\`\`diff\n${diffBlock.trim().slice(0, 2000)}\n\`\`\``);
      appliedDiffs.push({ diff: diffBlock.trim(), applied: false, paths: [], reason: review.reason, alreadyApplied: false });
      return results;
    }
    const reason = `Rechazado en la revisión: ${review.reason}`;
    send('log', { type: 'err', title: 'Cambio rechazado en la revisión', detail: review.reason });
    session.addLog({ type: 'err', title: 'Cambio rechazado en la revisión', detail: review.reason });
    results.push(`### Cambio RECHAZADO en la revisión (NO aplicado)\n${reason}\nCorrige el cambio y vuelve a intentarlo.\n\`\`\`diff\n${diffBlock.trim().slice(0, 2000)}\n\`\`\``);
    appliedDiffs.push({ diff: diffBlock.trim(), applied: false, paths: [], reason, alreadyApplied: false });
    return results;
  }
  const applied = await git.applyUnifiedDiff(session.dir, diffBlock);
  results.push(...applied);
  appliedDiffs.push({
    diff: diffBlock.trim(),
    applied: applied.every((r) => r.applied),
    paths: applied.map((r) => r.path).filter(Boolean),
    reason: applied.find((r) => !r.applied)?.reason || null,
    alreadyApplied: applied.some((r) => r.alreadyApplied),
  });
  for (const item of applied) {
    const event = item.applied
      ? { type: 'ok', title: `Cambio aplicado: ${item.path}`, detail: 'Archivo guardado y listo para comprobar' }
      : { type: item.alreadyApplied ? 'info' : 'err', title: item.alreadyApplied ? `Cambio ya aplicado: ${item.path}` : `Cambio no aplicado: ${item.path || '(sin archivo)'}`, detail: item.reason };
    send('log', event);
    send('computer', { mode: 'files', action: item.applied ? 'write' : 'write_failed', path: item.path, bytes: item.bytes, text: item.reason });
    session.addLog(event);
    if (item.applied && item.path && !autoAppliedPaths.includes(item.path)) autoAppliedPaths.push(item.path);
  }
  return results;
}

/**
 * Rama por tarea estilo Codex (H3): antes del primer diff del turno,
 * el trabajo pasa a su propia rama `baro/<slug>-<ts>` y main queda
 * intacto. Si la sesión ya está en una rama baro/* (o en otra rama
 * que no sea main/master), se reutiliza. Si no se puede crear, el
 * turno continúa en la rama actual y lo dice en el log — nunca
 * rompe el trabajo por esto. La ref de la rama se publica (push
 * sin commits) cuando hay token, para que una reconexión no falle
 * por buscar una rama que solo existe en local.
 */
async function ensureTaskBranch(session, send, taskTitle) {
  if (!session.repoFullName) return null;
  if (session.taskBranch) return session.taskBranch;
  if (session.taskBranchAttempted) return null;
  let current = null;
  try {
    current = await git.getCurrentBranch(session.dir);
  } catch {
    return null;
  }
  const base = session.baseBranch || current || session.branch || 'main';
  if (current && current !== 'main' && current !== 'master') {
    session.taskBranch = current;
    session.baseBranch = base;
    return current;
  }
  session.taskBranchAttempted = true;
  try {
    const created = await git.createTaskBranch(session.dir, base, taskTitle);
    session.baseBranch = created.base;
    session.taskBranch = created.branch;
    session.branch = created.branch;
    session.taskBranchAttempted = false;
    send('log', { type: 'info', title: 'Trabajo guardado por separado', detail: 'Tus cambios de este turno quedan aparte hasta que decidas subirlos' });
    const token = session.githubToken || process.env.GITHUB_TOKEN;
    const parsed = git.parseRepoUrl(`https://github.com/${session.repoFullName}`);
    if (token && parsed) {
      try {
        await git.pushBranch({ dir: session.dir, branch: created.branch, token, owner: parsed.owner, repo: parsed.repo });
      } catch (e) {
        send('log', { type: 'info', title: 'Cambios guardados solo en este equipo por ahora' });
      }
    }
    return created.branch;
  } catch (e) {
    send('log', { type: 'info', title: 'No se pudo separar el trabajo', detail: 'Sigo con tus cambios en su lugar actual' });
    return null;
  }
}

function directoryHasPythonTests(dir, depth = 0) {
  if (depth > 4) return false;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /^(test_[^/]+|[^/]+_test)\.py$/i.test(entry.name)) return true;
    if (entry.isDirectory() && !/^(node_modules|\.git|\.venv|venv|__pycache__)$/i.test(entry.name)) {
      if (/^tests?$/i.test(entry.name)) {
        try {
          if (fs.readdirSync(path.join(dir, entry.name)).some((name) => /\.py$/i.test(name))) return true;
        } catch {}
      }
      if (directoryHasPythonTests(path.join(dir, entry.name), depth + 1)) return true;
    }
  }
  return false;
}

function detectAutoTestRunner(session) {
  const dir = session.dir;
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test) {
        return { binary: 'npm', args: ['test', '--silent'], label: 'npm test' };
      }
    }
  } catch {
    // Un package.json ilegible no debe tumbar la verificación de
    // otros ecosistemas presentes en el mismo workspace.
  }

  const pyprojectPath = path.join(dir, 'pyproject.toml');
  const pyproject = fs.existsSync(pyprojectPath)
    ? fs.readFileSync(pyprojectPath, 'utf8')
    : '';
  const hasPytestConfig = fs.existsSync(path.join(dir, 'pytest.ini'))
    || fs.existsSync(path.join(dir, 'tox.ini'))
    || /\[tool\.pytest/.test(pyproject)
    || (fs.existsSync(path.join(dir, 'setup.cfg'))
      && /\[tool:pytest\]/.test(fs.readFileSync(path.join(dir, 'setup.cfg'), 'utf8')));
  const hasPythonProject = !!pyproject
    || fs.existsSync(path.join(dir, 'requirements.txt'))
    || fs.existsSync(path.join(dir, 'setup.py'));
  if (hasPytestConfig || (hasPythonProject && directoryHasPythonTests(dir))) {
    return { binary: 'python3', args: ['-m', 'pytest', '-q'], label: 'python3 -m pytest -q' };
  }

  if (fs.existsSync(path.join(dir, 'go.mod'))) {
    return { binary: 'go', args: ['test', './...'], label: 'go test ./...' };
  }
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
    return { binary: 'cargo', args: ['test'], label: 'cargo test' };
  }
  return null;
}

/**
 * Verificación automática estilo Codex: detecta el runner real
 * del proyecto (npm, pytest, Go o Cargo), lo ejecuta una vez por
 * turno después de aplicar cambios y devuelve el resultado al
 * loop para que el agente corrija fallos sin intervención.
 * Emite el evento SSE `verify` además del log visible.
 * Devuelve el bloque de texto para el modelo, o null si no hay
 * runner detectable (dejando constancia honesta en el log).
 */
async function runAutoTests(session, send) {
  const runner = detectAutoTestRunner(session);
  if (!runner) {
    send('log', {
      type: 'info',
      title: 'Sin verificación automática disponible',
      detail: 'No encontré pruebas automáticas en este proyecto.',
    });
    session.addLog({
      type: 'info',
      title: 'Sin pruebas automáticas',
      detail: 'No se detectaron pruebas en este proyecto',
    });
    return null;
  }

  try {
    send('log', { type: 'run', title: 'Comprobando que todo funciona…' });
    const res = await runCommand(runner.binary, runner.args, session.dir, 120000);
    const out = truncateCommandOutput(res.stdout || res.stderr || res.error || '(sin salida)');
    const summary = out.slice(0, 300);
    send('log', {
      type: res.ok ? 'ok' : 'err',
      title: res.ok ? 'Verificación: tests pasaron' : 'Verificación: tests fallaron',
      detail: summary,
    });
    send('verify', { ok: !!res.ok, summary });
    session.addLog({
      type: res.ok ? 'ok' : 'err',
      title: 'Comprobación automática',
      detail: summary,
    });
    return `### Verificación automática: ${res.ok ? '✅ PASARON' : '❌ FALLARON'}\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\`${res.ok ? '' : '\nCorrige los fallos con otro cambio exacto y vuelve a verificar.'}`;
  } catch (e) {
    const summary = String(e.message || e).slice(0, 300);
    send('log', { type: 'err', title: 'Verificación automática falló al ejecutarse', detail: summary });
    send('verify', { ok: false, summary });
    return `### Verificación automática: ❌ NO SE PUDO EJECUTAR\n${summary}`;
  }
}

/**
 * Contexto largo estilo Astra: cuando el historial crece
 * demasiado, se resume la parte vieja en un bloque compacto
 * en vez de truncarla a ciegas. Así el agente "recuerda" hilos
 * largos sin quemar la ventana del modelo gratuito.
 */
const HISTORY_COMPACT_AT = 24;  // mensajes
const HISTORY_KEEP_TAIL = 16;   // mensajes recientes intactos

async function maybeCompactHistory(session, signal) {
  const h = session.history || [];
  if (h.length <= HISTORY_COMPACT_AT) return false;
  const oldPart = h.slice(0, h.length - HISTORY_KEEP_TAIL);
  const tail = h.slice(-HISTORY_KEEP_TAIL);
  try {
    const summary = await generateText(
      'Resume esta conversación de forma compacta y fiel (máximo 25 líneas): ' +
      'temas tratados, decisiones tomadas, datos importantes y en qué quedó lo último. ' +
      'Sin adornos, solo el resumen.\n\n' +
      oldPart.map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${String(m.content || '').slice(0, 2000)}`).join('\n\n'),
      signal
    );
    session.history = [
      { role: 'user', content: `## Resumen del contexto anterior (compactado automáticamente)\n${summary}` },
      ...tail,
    ];
    return true;
  } catch (e) {
    // Si el resumen falla, se trunca sin romper el turno.
    session.history = tail;
    return false;
  }
}

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
// Extrae el primer bloque de codigo cercado (```lang ... ```) del texto
// fuente (normalmente la respuesta de la IA). Si el nombre del archivo
// sugiere un lenguaje (ej. .py), se prefiere un bloque de ese lenguaje;
// si no, se toma el primer bloque cercado que haya.
function extractFencedCode(text, fileName) {
  const src = String(text || '');
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  const langHint = { py: 'python', pyw: 'python', js: 'javascript', ts: 'typescript', sh: 'bash', rb: 'ruby', php: 'php' }[ext];
  const fenceRe = /```(\w*)\s*\n([\s\S]*?)```/g;
  let m;
  let first = null;
  while ((m = fenceRe.exec(src))) {
    const lang = (m[1] || '').toLowerCase();
    const code = m[2].replace(/\n$/, '');
    if (!code.trim()) continue;
    if (!first) first = code;
    if (langHint && (lang === langHint || lang === ext)) return code;
  }
  return first;
}

function statusPathFromLine(line) {
  const raw = String(line || '').slice(3).trim();
  if (!raw) return '';
  const renamed = raw.split(' -> ');
  return (renamed[renamed.length - 1] || '').replace(/^"|"$/g, '');
}

/**
 * Revisión de código READ-ONLY estilo Codex /review.
 * Lee el estado y el diff contra HEAD, pide al modelo SOLO una
 * revisión estructurada y elimina cualquier bloque ```diff de
 * la respuesta: esta herramienta jamás aplica cambios.
 */
async function reviewCodeReadOnly({ session, focus, generateTextFn }) {
  if (!session?.dir || !fs.existsSync(path.join(session.dir, '.git'))) {
    return 'No hay un repositorio Git conectado en esta sesión, así que no hay cambios contra HEAD para revisar.';
  }

  const statusRes = await runCommand('git', ['status', '--short'], session.dir, 30000);
  if (!statusRes.ok) {
    return `No se pudo leer el estado Git del workspace: ${statusRes.error || statusRes.stderr || 'error desconocido'}`;
  }
  const statusLines = String(statusRes.stdout || '').split(/\r?\n/).filter(Boolean);
  if (!statusLines.length) {
    return 'No hay cambios sin commitear contra HEAD: el árbol de trabajo está limpio, no hay nada que revisar.';
  }

  const material = [];
  let budget = 24_000;
  for (const line of statusLines.slice(0, 30)) {
    const relPath = statusPathFromLine(line);
    if (!relPath) continue;
    const isUntracked = line.startsWith('??');
    let chunk = '';
    if (isUntracked) {
      try {
        const content = await git.readFile(session.dir, relPath);
        chunk = `### ${relPath} (archivo nuevo sin seguimiento)\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``;
      } catch {
        chunk = `### ${relPath} (archivo nuevo sin seguimiento; no se pudo leer su contenido)`;
      }
    } else {
      const diff = await git.diffAgainstHead(session.dir, relPath);
      chunk = diff
        ? `### ${relPath}\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``
        : `### ${relPath}\n(sin diff textual contra HEAD)`;
    }
    if (budget <= 0) break;
    material.push(chunk.slice(0, budget));
    budget -= chunk.length;
  }

  const prompt = [
    'Actúa como revisor de código senior de Codex en modo SOLO LECTURA (/review).',
    'Revisa los cambios contra HEAD y busca bugs reales, regresiones, riesgos de seguridad, pérdida de datos y huecos de tests. No inventes problemas genéricos.',
    focus ? `Foco pedido por el usuario: ${focus}` : '',
    '',
    'Formato OBLIGATORIO:',
    '## Veredicto',
    '<una línea: "El parche parece correcto" o "El parche tiene problemas">',
    '',
    '## Hallazgos',
    '- [P0|P1|P2] ruta/archivo:línea — problema concreto y por qué importa',
    'P0 = rompe en producción o seguridad/datos; P1 = bug probable o regresión; P2 = riesgo menor o hueco de tests.',
    'Si no hay hallazgos reales, escribe exactamente: "Sin hallazgos."',
    '',
    '## Resumen',
    '<2-4 líneas>',
    '',
    'PROHIBIDO: proponer diffs, bloques de código ```diff, parches aplicables o cambios. Solo revisión.',
    '',
    `Estado Git:\n${statusLines.join('\n')}`,
    '',
    material.join('\n\n'),
  ].filter(Boolean).join('\n');

  const rawReview = await generateTextFn(prompt);
  if (!rawReview || !String(rawReview).trim()) {
    return 'El modelo no devolvió una revisión. No se aplicó ningún cambio.';
  }
  const cleanReview = String(rawReview)
    .replace(/```diff[\s\S]*?```/gi, '[bloque diff omitido: la revisión es de solo lectura]')
    .trim();
  return [
    `**Alcance:** ${statusLines.length} archivo(s) con cambios por revisar.`,
    focus ? `**Foco:** ${focus}` : '',
    '',
    cleanReview,
  ].filter(Boolean).join('\n');
}

async function runToolCommand(command, send, session, signal, sourceText = '') {
  const onStep = (step) => {
    switch (step.type) {
      case 'search_start':
        send('log', { type: 'run', title: `Buscando en internet: "${step.query}"` });
        send('computer', { mode: 'browser', action: 'search', engine: 'web', query: step.query });
        break;
      case 'search_visit':
        send('log', { type: 'info', title: `Visitando: ${safeUrlHostname(step.url)}`, detail: step.title });
        send('computer', { mode: 'browser', action: 'visit', url: step.url, title: step.title, snippet: step.snippet });
        break;
      case 'search_done':
        send('log', { type: 'ok', title: `Búsqueda completada`, detail: `${step.count} resultado(s)` });
        send('computer', { mode: 'browser', action: 'search_done', count: step.count });
        break;
      case 'wiki_start':
        send('log', { type: 'run', title: `Buscando un dato: "${step.query}"` });
        send('computer', { mode: 'browser', action: 'search', engine: 'wikipedia', query: step.query });
        break;
      case 'wiki_visit':
        send('log', { type: 'info', title: `Artículo encontrado: ${step.title}` });
        send('computer', { mode: 'browser', action: 'visit', url: `https://es.wikipedia.org/wiki/${encodeURIComponent(step.title.replace(/ /g, '_'))}`, title: step.title, snippet: 'Abriendo artículo…' });
        break;
      case 'wiki_done':
        send('log', { type: step.found ? 'ok' : 'err', title: step.found ? 'Dato encontrado' : 'No se encontró artículo' });
        if (step.found) send('computer', { mode: 'browser', action: 'visit', url: step.url, title: step.title, snippet: step.extract });
        else send('computer', { mode: 'browser', action: 'search_done', count: 0 });
        break;
      case 'video_start':
        send('log', { type: 'run', title: `Generando video (${step.targetSeconds}s)` });
        send('computer', { mode: 'terminal', action: 'run', command: `generar-video --duracion ${step.targetSeconds}s` });
        break;
      case 'video_clip_start':
        send('log', { type: 'run', title: `Clip ${step.clipIndex}: generando ${step.clipDuration}s` });
        send('computer', { mode: 'terminal', action: 'output', text: `[clip ${step.clipIndex}] generando ${step.clipDuration}s…`, ok: true });
        break;
      case 'video_clip_progress': {
        const statusEs = { queued: 'en cola', processing: 'procesando', succeeded: 'listo', failed: 'falló' }[step.status] || 'procesando';
        send('log', { type: 'info', title: `Clip ${step.clipIndex}: ${statusEs}` });
        send('computer', { mode: 'terminal', action: 'output', text: `[clip ${step.clipIndex}] estado: ${statusEs}`, ok: true });
        break;
      }
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
      // ── Investigación profunda estilo Astra ──
      case 'research_start':
        send('log', { type: 'run', title: 'Investigación profunda iniciada', detail: step.topic });
        send('computer', { mode: 'browser', action: 'search', engine: 'web', query: step.topic });
        break;
      case 'research_angle':
        send('log', { type: 'run', title: `Ángulo ${step.index + 1}/${step.total}: "${step.query}"` });
        send('computer', { mode: 'browser', action: 'search', engine: 'web', query: step.query });
        break;
      case 'research_visit':
        send('log', { type: 'info', title: `Leyendo fuente: ${safeUrlHostname(step.url)}`, detail: step.title });
        send('computer', { mode: 'browser', action: 'visit', url: step.url, title: step.title, snippet: step.snippet });
        break;
      case 'research_synthesize':
        send('log', { type: 'run', title: 'Sintetizando informe con las fuentes…', detail: `${step.sources} fuente(s)` });
        send('computer', { mode: 'browser', action: 'search_done', count: step.sources });
        break;
      case 'research_done':
        send('log', { type: 'ok', title: 'Investigación completada', detail: `${step.sources} fuente(s) consultadas` });
        break;
    }
  };

  try {
    if (command.tool === 'session-note') {
      // Nota duradera de sesión estilo Astra: interna, no se muestra
      // como bloque al usuario (return null la excluye del texto visible).
      const saved = session.addNote(command.text);
      send('log', { type: 'info', title: saved ? 'Nota guardada en la memoria de la sesión' : 'Nota duplicada, ignorada', detail: String(command.text).slice(0, 100) });
      return null;
    }
    if (command.tool === 'code-review') {
      send('log', { type: 'run', title: 'Revisando código (solo lectura)…', detail: command.focus || 'tus últimos cambios' });
      send('computer', { mode: 'terminal', action: 'run', command: 'code-review --read-only' });
      const review = await reviewCodeReadOnly({
        session,
        focus: command.focus,
        generateTextFn: (prompt) => generateText(prompt, signal),
      });
      send('log', { type: 'ok', title: 'Revisión de código completada (sin aplicar cambios)' });
      send('computer', { mode: 'terminal', action: 'done', text: 'Revisión completada: no se aplicó ningún cambio', ok: true });
      return `### Revisión de código (solo lectura)\n\n${review}`;
    }
    if (command.tool === 'search') {
      const result = await tools.webSearch({ query: command.query, onStep, signal });
      const lines = result.results.map((r, i) => `${i + 1}. **${r.title}** — ${r.url}\n   ${r.snippet}`).join('\n\n');
      return `### Resultado de búsqueda web: "${command.query}"\n${result.answer ? `Respuesta directa: ${result.answer}\n\n` : ''}${lines || 'Sin resultados.'}`;
    }
    if (command.tool === 'wikipedia') {
      const result = await tools.wikipediaLookup({ query: command.query, onStep, signal });
      if (!result.found) return `### Wikipedia: "${command.query}"\nNo se encontró ningún artículo relevante.`;
      return `### Wikipedia: ${result.title}\n${result.extract}\n\nFuente: ${result.url}`;
    }
    if (command.tool === 'video') {
      const result = await tools.generateVideo({ prompt: command.prompt, durationSec: command.durationSec, onStep, signal });
      const clipList = result.clips.map((c) => `- Clip ${c.index} (${c.seconds}s): ${c.url}`).join('\n');
      return `### Video generado: "${command.prompt}"\nDuración total: ${result.totalSeconds}s en ${result.clips.length} clip(s)\n${clipList}`;
    }
    if (command.tool === 'image') {
      const result = await tools.editImage({ imageUrl: command.imageUrl, instruction: command.instruction, onStep, signal });
      return `### Imagen editada\nInstrucción: ${command.instruction}\n${result.imageUrl ? `Resultado: ${result.imageUrl}` : 'No se pudo generar la imagen editada.'}${result.note ? `\nNota: ${result.note}` : ''}`;
    }
    if (command.tool === 'image-gen') {
      // Generación de imagen GRATIS y sin clave (Pollinations/FLUX).
      // La URL resultante se inyecta como markdown para que el
      // frontend la renderice, y además se emite un evento 'computer'
      // con mode 'image' para la tarjeta visual en vivo.
      send('log', { type: 'run', title: 'Generando imagen con IA', detail: command.prompt });
      send('computer', { mode: 'image', action: 'start', prompt: command.prompt });
      const result = await tools.generateImage({
        prompt: command.prompt,
        signal,
        onStep: (step) => {
          if (step.type === 'image_done') {
            send('log', { type: 'ok', title: 'Imagen generada' });
            send('computer', { mode: 'image', action: 'done', prompt: command.prompt, url: step.url });
          }
        },
      });
      return `### Imagen generada: "${command.prompt}"\n\n![imagen generada por IA](${result.imageUrl})\n\n[Ver imagen en tamaño completo](${result.imageUrl})`;
    }
    if (command.tool === 'memory') {
      const saved = session.addMemory(command.text);
      send('log', { type: saved ? 'ok' : 'info', title: saved ? 'Guardado en memoria' : 'Ya estaba en memoria', detail: command.text });
      const scopeNote = 'Lo recordaré en futuras conversaciones, aunque cierres la app.';
      return saved
        ? `### Memoria guardada\nHe guardado en mi memoria: "${command.text}". ${scopeNote}`
        : `### Memoria\nEse dato ya estaba en mi memoria: "${command.text}".`;
    }
    if (command.tool === 'doc-gen') {
      // Document Studio estilo Astra: la IA redacta el contenido,
      // aquí se convierte a .docx/.pptx/.xlsx real y descargable.
      const kindLabel = { documento: 'documento', presentacion: 'presentación', hoja: 'hoja de cálculo' }[command.kind] || command.kind;
      send('log', { type: 'run', title: `Creando ${kindLabel}`, detail: command.title });
      send('computer', { mode: 'docs', action: 'start', kind: command.kind, title: command.title });
      const result = await tools.generateDocument({
        kind: command.kind,
        title: command.title,
        brief: command.brief,
        sessionId: session.id,
        sessionDir: session.dir,
        generateText: (prompt) => generateText(prompt, signal),
        onStep: (step) => {
          if (step.type === 'doc_content') send('log', { type: 'info', title: 'Redactando contenido con IA...' });
        },
      });
      send('log', { type: 'ok', title: `${kindLabel} listo: ${result.fileName}`, detail: `${Math.round(result.bytes / 1024)} KB` });
      send('computer', { mode: 'docs', action: 'done', kind: command.kind, title: command.title, fileName: result.fileName, bytes: result.bytes, url: result.downloadUrl });
      const cap = kindLabel[0].toUpperCase() + kindLabel.slice(1);
      return `### ${cap} creado: "${command.title}"\n\n[Descargar ${result.fileName}](${result.downloadUrl}) (${Math.round(result.bytes / 1024)} KB)`;
    }
    if (command.tool === 'script') {
      // Crear script: la IA escribe el codigo en un bloque cercado en
      // su respuesta; aqui se guarda como archivo REAL en
      // workspaces/<sid>/scripts/ y queda listo para ejecutarse con
      // "Ejecuta: python3 scripts/<nombre>" en el mismo turno.
      // NO necesita repositorio: es la via para crear y correr Python
      // (o JS, etc.) con trabajo visible en tiempo real.
      // H1: con la tool nativa create_script el código llega en
      // command.code y tiene prioridad sobre el bloque cercado.
      let name = String(command.name || '').trim();
      if (!name) return '### Crear script\nFalta el nombre del archivo. Usa el formato: `Crear script: nombre.py :: descripcion`.';
      if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.py';
      if (name.includes('/') || name.includes('\\') || !isSafeWorkspaceArgument(name)) {
        return `### Crear script\nNombre no permitido: "${command.name}". Usa un nombre simple como \`utilidad.py\`.`;
      }
      const code = (typeof command.code === 'string' && command.code.trim())
        ? command.code
        : extractFencedCode(sourceText, name);
      if (!code) {
        return `### Crear script: ${name}\nNo encontre el codigo en tu respuesta. Escribe la linea \`Crear script: ${name}\` y justo despues el codigo completo en un bloque cercado (por ejemplo \`\`\`python ... \`\`\`).`;
      }
      if (code.length > 200_000) return `### Crear script: ${name}\nEl codigo es demasiado largo (${Math.round(code.length / 1024)} KB, maximo 200 KB).`;
      const scriptsDir = path.join(session.dir, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      const fullPath = path.join(scriptsDir, name);
      fs.writeFileSync(fullPath, code, 'utf8');
      const bytes = fs.statSync(fullPath).size;
      const rel = `scripts/${name}`;
      send('log', { type: 'ok', title: `Script creado: ${name}`, detail: `${code.split('\n').length} líneas · ${bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`}` });
      send('computer', { mode: 'files', action: 'write', path: rel, bytes });
      session.addLog?.({ type: 'ok', title: `Script creado: ${name}`, detail: rel });
      const downloadUrl = `/api/files/download?sessionId=${encodeURIComponent(session.id)}&file=${encodeURIComponent(rel)}`;
      return `### Script creado: \`${name}\`\n${command.brief ? `_${command.brief}_\n` : ''}\n[Descargar ${name}](${downloadUrl}) — también quedó guardado y listo para ejecutar.`;
    }
    if (command.tool === 'run') {
      // Ejecuta: determinista (del usuario o del modelo): corre por la
      // lista blanca de commandRunner en el workspace de la sesión y
      // devuelve la salida REAL. Sin repo también vale: el workspace
      // general guarda los scripts en scripts/.
      const parsed = extractAutomaticCommands(`Ejecuta: ${command.commandLine}`);
      if (!parsed.length) {
        return `### Ejecutar\nNo se pudo interpretar el comando: "${command.commandLine}". Formato: \`Ejecuta: <comando>\`.`;
      }
      const blocks = [];
      for (const cmd of parsed) {
        send('log', { type: 'run', title: 'Ejecutando…' });
        send('computer', { mode: 'terminal', action: 'run', command: cmd.display });
        const r = await runCommand(cmd.binary, cmd.args, session.dir);
        const out = truncateCommandOutput(r.stdout || r.stderr || r.error || '');
        send('log', { type: r.ok ? 'ok' : 'err', title: r.ok ? 'Completado' : 'Falló', detail: out });
        send('computer', { mode: 'terminal', action: 'output', text: out || (r.ok ? '(sin salida)' : 'error'), ok: r.ok });
        session.addLog?.({ type: r.ok ? 'ok' : 'err', title: 'Ejecutar', detail: out });
        blocks.push(commandResultForModel(cmd, r));
      }
      return blocks.join('\n\n');
    }
    if (command.tool === 'computer') {
      // Modo computadora estilo Astra: un Chromium REAL que el agente
      // VE (capturas en vivo) y controla de forma autónoma (clic,
      // escritura, scroll, teclas) hasta completar la tarea.
      send('log', { type: 'run', title: 'Modo computadora', detail: command.task });
      const result = await runComputerTask({
        task: command.task,
        session,
        send,
        generateText: (prompt) => generateText(prompt, signal),
      });
      return `### Modo computadora: "${command.task}"\n\n${result.ok ? '✅' : '⚠️'} ${result.summary}`;
    }
    if (command.tool === 'deep-research') {
      // Investigación profunda estilo Astra: varias búsquedas desde
      // ángulos distintos + lectura de fuentes + informe sintetizado
      // con citas. El bloque se muestra tal cual al usuario.
      const result = await tools.deepResearch({
        topic: command.topic,
        generateText: (prompt) => generateText(prompt, signal),
        onStep,
        signal,
      });
      const sourceList = result.sources
        .map((s, i) => `${i + 1}. **${s.title}** — ${s.url}`)
        .join('\n');
      return `### Investigación profunda: "${command.topic}"\n\n${result.report}\n\n### Fuentes\n${sourceList}`;
    }
  } catch (e) {
    send('log', { type: 'err', title: 'No se pudo completar esa acción', detail: e.message });
    return `### Error ejecutando la acción\n${e.message}`;
  }
  return '';
}

function summarizeDiffResults(results) {
  return results.map((result) => {
    if (typeof result === 'string') return result; // bloque de rechazo del revisor, ya formateado
    const state = result.applied
      ? 'aplicado'
      : result.alreadyApplied
      ? 'ya estaba aplicado'
      : `no aplicado: ${result.reason}`;
    return `- ${result.path || '(sin archivo)'}: ${state}`;
  }).join('\n');
}

// Mensaje de error para el cliente: corto y en lenguaje normal, sin
// nombres de claves, proveedores, rutas ni códigos internos. El detalle
// técnico queda en el log del servidor para quien lo administra.
function friendlyError(e) {
  const msg = e && e.message ? String(e.message) : '';
  if (msg) console.error('[baro] error del turno:', msg);
  if (/API_KEY|_KEY|clave/i.test(msg)) return 'Una función no está configurada en el servidor.';
  if (/ECONNREFUSED|127\.0\.0\.1|localhost|11434/i.test(msg)) return 'El servicio local no responde. Inténtalo de nuevo en un momento.';
  if (/HTTP \d+|status \d+|\b503\b|\b429\b|\b500\b/i.test(msg)) return 'El servicio no respondió. Inténtalo de nuevo en un momento.';
  if (msg && msg.length < 200 && !/[A-Z_]{4,}/.test(msg)) return msg.slice(0, 200);
  return 'Algo salió mal al generar la respuesta. Inténtalo de nuevo.';
}

// runChatTurn — el cuerpo del turno, separado del transporte (v10 H2).
// Antes vivía en handleChatTurn y moría si se cerraba la conexión:
// `req.on('close')` abortaba el turno. Ahora corre dentro de un
// trabajo (jobsStore): `send` vuelca cada evento al trabajo —queda
// persistido y se reenvía en vivo— y `signal` solo se aborta cuando
// el usuario cancela el trabajo, nunca al cerrarse una conexión.
// Devuelve { status: 'done'|'failed'|'cancelled', text, diffCount,
// autoAppliedPaths, appliedDiffs, threadId, error?, aborted? }.
async function runChatTurn({ session, input, send: sendEvent, signal, job }) {
  let {
    message,
    model,
    planMode,
    multiAgent,
    fileLimit,
    autoApply = true,
    threadId: requestedThreadId,
  } = input || {};
  const isPlanMode = !!planMode;
  const isMultiAgent = multiAgent === true || multiAgent === 1 || multiAgent === 'true';
  const requestedFileLimit = Number(fileLimit);
  const effectiveFileLimit = Number.isFinite(requestedFileLimit)
    ? Math.min(300, Math.max(10, Math.trunc(requestedFileLimit)))
    : 10;
  if (!session) return { status: 'failed', error: 'Sesion no encontrada. Recarga la app.' };

  // El sumidero ya persiste (jobsStore.appendEvent); aquí solo se
  // protege el turno de un sumidero roto.
  const send = (event, data) => {
    try { sendEvent(event, data); } catch { /* nunca romper el turno */ }
  };

  if (typeof message !== 'string' || !message.trim()) {
    send('log', { type: 'err', title: 'Mensaje inválido', detail: 'Falta el texto del mensaje' });
    send('error', { error: 'Falta el mensaje: escribe algo antes de enviar.' });
    return { status: 'failed', error: 'Falta el mensaje: escribe algo antes de enviar.' };
  }
  message = message.trim();

  // Hilos (FASE 3): el turno trabaja sobre la conversación indicada.
  // Al abrir una conversación, su historial sustituye al de la sesión
  // (cambiar de conversación no mezcla contextos); si no hay
  // conversación, se crea una para que el turno quede guardado.
  let threadId = typeof requestedThreadId === 'string' && requestedThreadId ? requestedThreadId : null;
  let thread = threadId ? threadsStore.getThread(session.ownerUid, threadId) : null;
  if (!thread) {
    thread = threadsStore.createThread(session.ownerUid);
    threadId = thread ? thread.id : null;
  }
  if (thread) {
    session.history = thread.messages.slice(-14).map((m) => ({
      role: m.role === 'me' ? 'user' : 'assistant',
      content: m.text,
    }));
  }
  // El mensaje del usuario se guarda AL EMPEZAR el turno: así la
  // lista muestra el título y el preview reales de inmediato, y si
  // el usuario vuelve a mitad del trabajo, la conversación ya trae
  // lo que pidió (sin respuesta inventada: la respuesta se guarda
  // solo cuando el turno termina).
  if (threadId) {
    threadsStore.appendToThread(session.ownerUid, threadId, [{ role: 'me', text: message }]);
  }

  const planSteps = [
    { id: 'analizar', label: 'Analizar la petición', status: 'active' },
    { id: 'actuar', label: 'Ejecutar y editar', status: 'pending' },
    { id: 'verificar', label: 'Verificar con tests', status: 'pending' },
  ];
  const sendPlan = (activeId, complete = false) => {
    try {
      const activeIndex = planSteps.findIndex((step) => step.id === activeId);
      planSteps.forEach((step, index) => {
        step.status = complete || (activeIndex >= 0 && index < activeIndex)
          ? 'done'
          : index === activeIndex
          ? 'active'
          : 'pending';
      });
      send('plan', { steps: planSteps.map((step) => ({ ...step })) });
    } catch {
      // El plan es informativo: nunca debe romper el turno.
    }
  };

  try {
    sendPlan('analizar');
    if (isPlanMode) {
      send('log', {
        type: 'info',
        title: 'Modo plan activo: solo preparo el plan, sin cambiar nada',
        detail: 'Reviso y te propongo; no toco tus archivos hasta que lo apruebes.',
      });
    }
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
      const heuristicLimit = Math.max(0, effectiveFileLimit - mentionedPaths.length);
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
        send('log', { type: 'info', title: 'Resumen del proyecto', detail: `${allFiles.length} archivos` });
        enrichedMessage = `${message}\n\n## Estructura del repositorio\n\`\`\`\n${allFiles.slice(0, 100).join('\n')}\n\`\`\`\n\nSi necesitas ver un archivo especifico, dime su nombre o mencionalo con @.`;
      }
    }

    // AGENTS.md estilo Codex: instrucciones del propio proyecto,
    // recargadas en cada turno desde la raíz del workspace.
    let agentsInstructions = { text: '', files: [] };
    try {
      agentsInstructions = await loadAgentsInstructions(session.dir);
      if (agentsInstructions.text) {
        send('log', {
          type: 'info',
          title: 'Reglas del proyecto cargadas',
          detail: 'Se aplican las reglas de tu proyecto',
        });
      }
    } catch (e) {
      send('log', { type: 'info', title: 'No se pudieron cargar las reglas del proyecto', detail: e.message });
    }

    // H6: si el entorno del repo ya se preparó (o falló), el turno
    // lo sabe antes de escribir código; si aún se está preparando,
    // lo dice y sigue (el setup corre en segundo plano).
    if (session.repoFullName && session.envHealth) {
      const h = session.envHealth;
      send('log', {
        type: h.status === 'running' ? 'info' : (h.ok ? 'ok' : 'info'),
        title: h.status === 'running'
          ? 'Preparando el entorno del repo…'
          : (h.ok ? 'Entorno del repo listo' : 'Entorno del repo con problemas'),
        detail: h.detail || '',
      });
    }

    // El builder del system prompt es compartido (groqClient lo define,
    // pollinationsClient lo reutiliza): un solo lugar para la fecha/hora
    // real, la memoria a largo plazo y las herramientas.
    let systemPrompt = groq.buildSystemPrompt({
      repo: session.repoFullName,
      branch: session.branch,
      fileCount,
      instructions: session.instructions,
      planMode: isPlanMode,
      agentCapable: !!session.repoFullName,
      memory: session.memory,
      // H1: con GROQ_API_KEY el primer proveedor (Groq) soporta
      // function calling nativo; sin ella el prompt no promete
      // tools y el turno usa el formato de texto.
      toolsNative: !!process.env.GROQ_API_KEY,
    });
    const sessionNotesBlock = session.notesBlock?.() || '';
    if (sessionNotesBlock) {
      systemPrompt += `\n\n${sessionNotesBlock}`;
    }
    if (agentsInstructions.text) {
      systemPrompt += `\n\n## INSTRUCCIONES DEL PROYECTO (AGENTS.md)\nArchivos cargados: ${agentsInstructions.files.join(', ')}\n\n${agentsInstructions.text}`;
    }

    // Contexto largo estilo Astra: si el historial creció demasiado,
    // se resume la parte vieja en un bloque compacto en vez de
    // truncarla a ciegas. No rompe el turno si falla.
    await maybeCompactHistory(session, signal);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(session.history || []).slice(-14),
      { role: 'user', content: enrichedMessage },
    ];

    send('log', { type: 'run', title: 'Generando respuesta...' });

    // NOTA DE RENDIMIENTO: antes cada evento 'delta' llevaba el TEXTO
    // COMPLETO acumulado (O(n²) de red por respuesta). Ahora solo viaja
    // el fragmento nuevo y el frontend lo acumula — el stream es de
    // verdad en tiempo real, sin reenviar megabytes.
    // H1: primera llamada con herramientas nativas; si el proveedor
    // no las soporta, streamWithFailoverTools degrada a texto y lo
    // dice en el log (nunca se finge que hubo tool_calls).
    const firstTurn = await streamWithFailoverTools({
      model,
      messages,
      tools: BARO_TOOLS,
      signal: signal,
      onDelta: (delta) => send('delta', { delta }),
      onProvider: () => send('log', { type: 'info', title: 'Respondiendo…' }),
    });
    let result = firstTurn.text;
    let pendingToolCalls = Array.isArray(firstTurn.toolCalls) ? firstTurn.toolCalls : [];
    if (firstTurn.toolsSupported === false) {
      send('log', { type: 'info', title: 'Voy a responder con texto' });
    } else if (pendingToolCalls.length) {
      send('log', { type: 'info', title: 'Ejecutando acciones…' });
    }

    // La IA puede pedir comandos de inspección o validación en una línea
    // "Ejecuta: ...". Los ejecutamos aquí, en el workspace de la sesión, y
    // devolvemos el resultado a la IA para que continúe sin intervención.
    const conversation = [...messages];
    const seenCommands = new Set();
    let visibleResult = result;

    // ── Comandos directos del usuario ────────────────────
    // "Generar imagen: ...", "Recuerda: ...", "Buscar: ..." escritos
    // por el USUARIO se ejecutan de forma determinista ANTES de que
    // la IA hable: no dependen de que el modelo repita la línea en
    // su respuesta (los modelos gratuitos a veces devuelven vacío y
    // el comando se perdía sin dejar rastro). El resultado se inyecta
    // en la conversación para que la IA lo comente, no lo re-ejecute.
    const userToolCommands = extractToolCommands(message);
    const seenToolCommands = new Set(userToolCommands.map((c) => JSON.stringify(c)));
    if (userToolCommands.length) {
      sendPlan('actuar');
      // Multitarea estilo Astra: las herramientas independientes
      // corren en paralelo en vez de una por una.
      // EXCEPCIÓN: "Usar computadora" abre un navegador real con
      // pantalla en vivo y pasos secuenciales — siempre corre SOLO,
      // nunca en paralelo con otras herramientas del mismo lote.
      // El orden original de los resultados se conserva.
      send('log', { type: 'run', title: userToolCommands.length > 1 ? `Ejecutando ${userToolCommands.length} comandos...` : 'Ejecutando tu comando...' });
      const preToolTexts = new Array(userToolCommands.length);
      const preComputerIdx = [];
      const preRestIdx = [];
      const preBlockedIdx = [];
      userToolCommands.forEach((c, i) => {
        if (isPlanMode && !PLAN_MODE_READ_ONLY_TOOLS.has(c.tool)) preBlockedIdx.push(i);
        else if (c.tool === 'computer') preComputerIdx.push(i);
        else preRestIdx.push(i);
      });
      for (const i of preBlockedIdx) {
        send('log', {
          type: 'info',
          title: 'Modo plan: acción no ejecutada',
          detail: 'En modo plan solo miro y busco, no creo ni cambio nada.',
        });
        preToolTexts[i] = `### Acción no ejecutada por modo plan\nEsta acción genera o modifica contenido. En modo plan solo uso lectura, búsqueda y revisión; no se ejecutó nada.`;
      }
      // El texto fuente para las herramientas de los comandos del
      // usuario incluye la RESPUESTA del modelo: "Crear script" busca
      // ahí el bloque de código cercado que la IA acaba de escribir.
      // (Antes se pasaba solo el mensaje del usuario y el script
      // nunca encontraba el código aunque la IA lo hubiera dado.)
      const preToolSource = `${visibleResult || ''}\n${message}`;
      for (const i of preComputerIdx) {
        preToolTexts[i] = await runToolCommand(userToolCommands[i], send, session, signal, preToolSource);
      }
      if (preRestIdx.length) {
        // Orden importa cuando el mensaje trae "Crear script" y luego
        // "Ejecuta:" (el script debe existir antes de correrlo): en
        // ese caso los comandos del usuario van EN SECUENCIA, no en
        // paralelo.
        const needsOrder = preRestIdx.some((i) => ['script', 'run'].includes(userToolCommands[i].tool));
        if (!needsOrder && isMultiAgent && preRestIdx.length > 1) {
          send('log', { type: 'info', title: `Haciendo ${preRestIdx.length} cosas a la vez` });
        }
        if (needsOrder) {
          for (const i of preRestIdx) {
            preToolTexts[i] = await runToolCommand(userToolCommands[i], send, session, signal, preToolSource);
          }
        } else {
          const rest = await Promise.all(
            preRestIdx.map((i) => runToolCommand(userToolCommands[i], send, session, signal, preToolSource))
          );
          preRestIdx.forEach((origI, k) => { preToolTexts[origI] = rest[k]; });
        }
      }
      const preToolResults = preToolTexts.filter(Boolean);
      if (preToolResults.length) {
        visibleResult = visibleResult
          ? `${visibleResult}\n\n${preToolResults.join('\n\n')}`
          : preToolResults.join('\n\n');
        send('delta', { delta: `\n\n${preToolResults.join('\n\n')}` });
        conversation.push({
          role: 'user',
          content: [
            '## Comando directo del usuario YA EJECUTADO por el sistema (no repitas la línea de comando ni lo vuelvas a ejecutar)',
            ...preToolResults,
            '',
            'Si el mensaje traía algo más además del comando, responde a eso. Si solo era el comando, basta un comentario breve.',
          ].join('\n'),
        });
      }
    }

    const seenDiffs = new Set();
    let autoAppliedPaths = [];
    // Verificación automática: una vez por turno como máximo.
    let autoTestDone = false;
    const verifyResults = [];
    // Registro de CADA bloque de diff que el backend ya proceso (aplicado
    // o no) durante este turno, junto con su texto crudo. El frontend lo
    // usa para no repintar un boton "Aplicar" activo sobre un diff que el
    // propio servidor ya aplico via autoApply — pulsarlo de nuevo siempre
    // fallaba ("el diff no coincide", porque el archivo ya cambio), que
    // era la fuente mas comun de "error al aplicar cambios" reportada.
    const appliedDiffs = [];

    // Ejecutor de comandos automáticos, usado igual por la vía de
    // texto ("Ejecuta:") y por la tool nativa run_command.
    const executeAutomaticCommand = async (command) => {
      const title = 'Ejecutando…';
      send('log', { type: 'run', title });
      send('computer', { mode: 'terminal', action: 'run', command: command.display });
      session.addLog({ type: 'run', title });

      const commandResult = await runCommand(command.binary, command.args, session.dir);
      const output = truncateCommandOutput(commandResult.stdout || commandResult.stderr || commandResult.error);
      const logEntry = {
        type: commandResult.ok ? 'ok' : 'err',
        title: commandResult.ok ? 'Completado' : 'Falló',
        detail: output,
      };
      send('log', logEntry);
      send('computer', { mode: 'terminal', action: 'output', text: output || (commandResult.ok ? '(sin salida)' : 'error'), ok: commandResult.ok });
      session.addLog(logEntry);
      return commandResultForModel(command, commandResult);
    };

    // ── Despacho de tool_calls NATIVOS (H1) ────────────────
    // Traduce cada tool_call al mismo comando interno que su línea
    // de texto y lo ejecuta por la misma vía (mismo plan-mode,
    // misma deduplicación por seenToolCommands/seenDiffs, mismo
    // auto-review de diffs). Devuelve las contribuciones a
    // commandResults/toolResults/diffResults de la ronda.
    const dispatchNativeToolCalls = async (toolCalls, modelText) => {
      const out = { commandResults: [], toolResults: [], diffResults: [] };
      for (const tc of toolCalls || []) {
        const translated = toolCallToCommand(tc);
        if (translated.kind === 'invalid') {
          send('log', { type: 'err', title: 'No se pudo interpretar una acción', detail: 'Revisa la acción e inténtalo de nuevo.' });
          out.toolResults.push(`### No se pudo interpretar una acción\nLos argumentos no eran válidos; si no puedes, usa el formato de texto.`);
          continue;
        }
        if (translated.kind === 'diff') {
          const diffKey = String(translated.diff || '').trim();
          if (!diffKey || seenDiffs.has(diffKey)) continue;
          seenDiffs.add(diffKey);
          if (isPlanMode) {
            send('log', { type: 'info', title: 'Modo plan: cambio no aplicado todavía', detail: 'En modo plan no cambio archivos; sal del modo plan para aplicar.' });
            out.diffResults.push(`### Cambio NO aplicado por modo plan\nEl cambio queda solo como propuesta para revisión; no se escribió ningún archivo.\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
            appliedDiffs.push({ diff: diffKey, applied: false, paths: [], reason: 'Modo plan activo: sin cambios todavía', alreadyApplied: false });
            continue;
          }
          if (!session.repoFullName) {
            out.diffResults.push('### Cambio sin proyecto conectado\nPara aplicar cambios necesito un proyecto conectado en esta sesión.');
            continue;
          }
          if (!autoApply) {
            out.diffResults.push(`### Cambio propuesto (aplicación automática desactivada)\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
            appliedDiffs.push({ diff: diffKey, applied: false, paths: [], reason: 'Aplicación automática desactivada', alreadyApplied: false });
            continue;
          }
          await ensureTaskBranch(session, send, message);
          out.diffResults.push(...await processDiffBlock({ diffBlock: translated.diff, session, send, signal: signal, autoAppliedPaths, appliedDiffs }));
          continue;
        }
        const command = translated.command;
        const key = JSON.stringify(command);
        if (seenToolCommands.has(key)) continue;
        seenToolCommands.add(key);
        if (isPlanMode && !PLAN_MODE_READ_ONLY_TOOLS.has(command.tool)) {
          send('log', { type: 'info', title: 'Modo plan: acción no ejecutada', detail: 'En modo plan solo miro y busco, no creo ni cambio nada.' });
          out.toolResults.push(`### Acción no ejecutada por modo plan\nEsta acción crea o modifica contenido. En modo plan solo uso lectura, búsqueda y revisión; no se ejecutó ninguna acción.`);
          continue;
        }
        if (command.tool === 'computer') {
          const text = await runToolCommand(command, send, session, signal, modelText);
          if (text) out.toolResults.push(text);
          continue;
        }
        if (command.tool === 'run') {
          const parsed = extractAutomaticCommands(`Ejecuta: ${command.commandLine}`);
          if (!parsed.length) {
            out.commandResults.push(`### Ejecutar\nNo se pudo interpretar el comando: "${command.commandLine}".`);
            continue;
          }
          for (const cmd of parsed.slice(0, MAX_COMMANDS_PER_ROUND)) {
            const cmdKey = `${cmd.binary}\u0000${cmd.args.join('\u0000')}`;
            if (seenCommands.has(cmdKey)) continue;
            seenCommands.add(cmdKey);
            out.commandResults.push(await executeAutomaticCommand(cmd));
          }
          continue;
        }
        const text = await runToolCommand(command, send, session, signal, modelText);
        if (text) out.toolResults.push(text);
      }
      return out;
    };

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
      if (commands.length || diffResults.length || requestedTools.length || git.extractDiffBlocks(result).length) {
        sendPlan('actuar');
      }
      if (isPlanMode && session.repoFullName) {
        const plannedDiffBlocks = git.extractDiffBlocks(result)
          .map((block) => block.trim())
          .filter((block) => block && !seenDiffs.has(block));
        for (const diffKey of plannedDiffBlocks) {
          seenDiffs.add(diffKey);
          send('log', {
            type: 'info',
            title: 'Modo plan: cambio no aplicado todavía',
            detail: 'En modo plan no cambio archivos; sal del modo plan para aplicar.',
          });
          diffResults.push(`### Cambio NO aplicado por modo plan\nEl cambio queda solo como propuesta para revisión; no se escribió ningún archivo.\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
          appliedDiffs.push({
            diff: diffKey,
            applied: false,
            paths: [],
            reason: 'Modo plan activo: sin cambios todavía',
            alreadyApplied: false,
          });
        }
      }
      if (autoApply && !isPlanMode && session.repoFullName) {
        const diffBlocks = git.extractDiffBlocks(result);
        if (diffBlocks.length) await ensureTaskBranch(session, send, message);
        for (const diffBlock of diffBlocks) {
          const diffKey = diffBlock.trim();
          if (!diffKey || seenDiffs.has(diffKey)) continue;
          seenDiffs.add(diffKey);
          diffResults.push(...await processDiffBlock({ diffBlock, session, send, signal: signal, autoAppliedPaths, appliedDiffs }));
        }
      }

      // ── Tool_calls nativos de esta ronda (H1) ────────────
      // Se despachan con el mismo plan-mode y deduplicación que la
      // vía de texto; sus resultados se suman a los de esta ronda.
      if (pendingToolCalls.length) {
        const native = await dispatchNativeToolCalls(pendingToolCalls, result);
        commandResults.push(...native.commandResults);
        toolResults.push(...native.toolResults);
        diffResults.push(...native.diffResults);
        pendingToolCalls = [];
      }

      if (!commands.length && !diffResults.length && !requestedTools.length) break;

      // ── Verificación automática estilo Astra: si este turno aplicó
      // cambios y el repo tiene script de test, se corre una vez y el
      // resultado vuelve al loop para auto-corrección.
      const anyApplied = diffResults.some((r) => r && typeof r === 'object' && r.applied);
      if (anyApplied && !autoTestDone) {
        autoTestDone = true;
        sendPlan('verificar');
        const testBlock = await runAutoTests(session, send);
        if (testBlock) verifyResults.push(testBlock);
      }

      // Multitarea estilo Astra: herramientas independientes en
      // paralelo; el orden de los resultados se conserva.
      // EXCEPCIÓN: "computer" abre un navegador real y corre SOLO.
      const roundToolTexts = new Array(requestedTools.length);
      const computerIdx = [];
      const restIdx = [];
      const blockedToolIdx = [];
      requestedTools.forEach((c, i) => {
        if (isPlanMode && !PLAN_MODE_READ_ONLY_TOOLS.has(c.tool)) blockedToolIdx.push(i);
        else if (c.tool === 'computer') computerIdx.push(i);
        else restIdx.push(i);
      });
      for (const i of blockedToolIdx) {
        send('log', {
          type: 'info',
          title: 'Modo plan: acción no ejecutada',
          detail: 'En modo plan solo miro y busco, no creo ni cambio nada.',
        });
        roundToolTexts[i] = `### Acción no ejecutada por modo plan\nEsta acción crea o modifica contenido y quedó bloqueada.`;
      }
      for (const i of computerIdx) {
        roundToolTexts[i] = await runToolCommand(requestedTools[i], send, session, signal, result);
      }
      if (restIdx.length) {
        if (isMultiAgent && restIdx.length > 1) {
          send('log', { type: 'info', title: `Haciendo ${restIdx.length} cosas a la vez` });
        }
        const rest = await Promise.all(
          restIdx.map((i) => runToolCommand(requestedTools[i], send, session, signal, result))
        );
        restIdx.forEach((origI, k) => { roundToolTexts[origI] = rest[k]; });
      }
      for (const toolText of roundToolTexts) {
        if (toolText) toolResults.push(toolText);
      }

      let executableCommands = commands;
      if (isPlanMode && commands.length) {
        send('log', {
          type: 'info',
          title: `Modo plan: ${commands.length} comando(s) no ejecutado(s)`,
          detail: 'En modo plan no ejecuto comandos',
        });
        commandResults.push([
          '## Comandos NO ejecutados por modo plan',
          ...commands.map((command) => `- ${command.display}: no ejecutado en modo plan`),
        ].join('\n'));
        executableCommands = [];
      }

      if (isMultiAgent && executableCommands.length > 1) {
        send('log', { type: 'info', title: `Haciendo ${executableCommands.length} cosas a la vez` });
        commandResults.push(...await Promise.all(executableCommands.map(executeAutomaticCommand)));
      } else {
        for (const command of executableCommands) {
          commandResults.push(await executeAutomaticCommand(command));
        }
      }

      // Cada bloque de verificación se entrega al modelo UNA sola
      // vez: antes vivía fuera del bucle y se re-anexaba en todas
      // las rondas posteriores, duplicando los tests en contexto.
      const verifyResultsToSend = verifyResults.splice(0, verifyResults.length);
      conversation.push({ role: 'assistant', content: result });
      conversation.push({
        role: 'user',
        content: [
          commandResults.length ? `## Resultados de comandos ejecutados automáticamente\n${commandResults.join('\n\n')}` : '',
          diffResults.length ? `## Cambios procesados automáticamente\n${summarizeDiffResults(diffResults)}` : '',
          toolResults.length ? `## Resultados de herramientas ejecutadas automáticamente (ya mostrados al usuario tal cual: PROHIBIDO repetir el bloque "###", las URLs o las imágenes — solo agrega, si aporta, un comentario breve interpretando ese resultado)\n${toolResults.join('\n\n')}` : '',
          verifyResultsToSend.length ? `${verifyResultsToSend.join('\n\n')}` : '',
          session.notesBlock(),
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
        send('delta', { delta: `\n\n${toolResults.join('\n\n')}` });
      }

      const nextTurn = await streamWithFailoverTools({
        model,
        messages: conversation,
        tools: BARO_TOOLS,
        signal: signal,
        onDelta: (delta) => send('delta', { delta }),
        onProvider: () => send('log', { type: 'info', title: 'Continuando…' }),
      });
      result = nextTurn.text;
      pendingToolCalls = Array.isArray(nextTurn.toolCalls) ? nextTurn.toolCalls : [];
      if (pendingToolCalls.length) {
        send('log', { type: 'info', title: 'Ejecutando acciones…' });
      }
      const previous = visibleResult;
      visibleResult = `${previous}\n\n${result}`;
    }

    if (visibleResult !== result) result = visibleResult;

    session.history = session.history || [];
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: result });
    if (threadId) {
      threadsStore.appendToThread(session.ownerUid, threadId, [{ role: 'ai', text: result }]);
    }

    const diffBlocks = git.extractDiffBlocks(result);
    sendPlan(null, true);
    send('log', { type: 'ok', title: 'Completado', detail: diffBlocks.length ? `${diffBlocks.length} cambio(s) propuesto(s)` : undefined });
    // diffCount cuenta también los diffs aplicados por tool nativa
    // (apply_diff no deja bloque ```diff en el texto visible).
    const donePayload = { text: result, diffCount: Math.max(diffBlocks.length, appliedDiffs.length), autoAppliedPaths, appliedDiffs, threadId };
    send('done', donePayload);
    return { status: 'done', ...donePayload };
  } catch (e) {
    if (e.name === 'AbortError') {
      send('log', { type: 'info', title: 'Detenido por el usuario' });
      send('done', { text: '', aborted: true });
      return { status: job && job.cancelRequested ? 'cancelled' : 'failed', aborted: true };
    }
    send('log', { type: 'err', title: 'Error', detail: friendlyError(e) });
    send('error', { error: friendlyError(e) });
    return { status: 'failed', error: friendlyError(e) };
  }
}

// runJob — corre un trabajo en la cadena de turnos de su sesión
// (un turno por sesión, en orden, como antes). El trabajo arranca
// en `queued` y pasa a `running` aquí; si la sesión ya no existe,
// falla con el motivo real en vez de quedarse colgado.
async function runJob(job) {
  // Cancelado antes de arrancar: no se ejecuta el turno.
  if (job.cancelRequested) {
    jobsStore.setStatus(job, 'cancelled');
    return;
  }
  const session = getOwnedSession(job.sessionId, job.ownerUid);
  if (!session) {
    jobsStore.setStatus(job, 'failed', { error: 'La sesión ya no existe. Recarga la app.' });
    return;
  }
  const controller = new AbortController();
  jobsStore.attachAbortController(job, controller);
  jobsStore.setStatus(job, 'running');
  const send = (event, data) => jobsStore.appendEvent(job, event, data);
  let outcome;
  try {
    outcome = await runChatTurn({
      session,
      input: { message: job.message, ...(job.input || {}) },
      send,
      signal: controller.signal,
      job,
    });
  } catch (e) {
    outcome = { status: 'failed', error: friendlyError(e) };
    try { send('error', { error: outcome.error }); } catch { /* sumidero roto */ }
  }
  jobsStore.detachAbortController(job);
  if (!outcome || typeof outcome.status !== 'string') outcome = { status: 'failed', error: 'El turno terminó sin resultado.' };
  if (outcome.status === 'done') {
    jobsStore.setStatus(job, 'done', {
      result: {
        text: outcome.text || '',
        diffCount: outcome.diffCount || 0,
        autoAppliedPaths: outcome.autoAppliedPaths || [],
        appliedDiffs: outcome.appliedDiffs || [],
        threadId: outcome.threadId || null,
      },
    });
  } else if (outcome.status === 'cancelled') {
    jobsStore.setStatus(job, 'cancelled');
  } else {
    jobsStore.setStatus(job, 'failed', { error: outcome.error || 'Algo salió mal.' });
  }
}

// POST /api/chat — crea el trabajo y responde 202 con su id.
// Antes devolvía el SSE del turno y moría si se cerraba la
// conexión; ahora el turno vive en el trabajo y el cliente se
// engancha con GET /api/jobs/:id/events (puede cerrar la pestaña
// y volver: el trabajo sigue y los eventos quedan guardados).
router.post('/chat', async (req, res) => {
  const session = getOwnedSession(String(req.body?.sessionId || ''), req.auth.uid);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada. Recarga la app.' });
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Falta el mensaje: envía un texto no vacío en el campo "message".' });
  const job = jobsStore.createJob(req.auth.uid, session.id, message, req.body?.threadId || null, {
    model: req.body?.model,
    planMode: req.body?.planMode === true,
    multiAgent: req.body?.multiAgent === true,
    fileLimit: Number(req.body?.fileLimit) || undefined,
    autoApply: req.body?.autoApply !== false,
  });
  const lockKey = `${session.ownerUid}:${session.id}`;
  const previous = chatTurnChains.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => runJob(job));
  chatTurnChains.set(lockKey, current);
  current.catch(() => {}).finally(() => {
    if (chatTurnChains.get(lockKey) === current) chatTurnChains.delete(lockKey);
  });
  return res.status(202).json({ jobId: job.id });
});

// GET /api/jobs — trabajos del usuario, más recientes primero.
router.get('/jobs', (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  res.json({ jobs: jobsStore.listJobs(req.auth.uid, { status, limit: 20 }) });
});

// GET /api/jobs/:id/events — SSE con los eventos del trabajo:
// primero reproduce los ya guardados y luego sigue en vivo.
// Cerrar esta conexión NO cancela el trabajo (esa es la gracia
// del H2): para cancelarlo está POST /api/jobs/:id/cancel.
router.get('/jobs/:id/events', (req, res) => {
  const job = jobsStore.getJob(req.params.id, req.auth.uid);
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado.' });
  res.setTimeout(0);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const write = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`); } catch { /* cliente ido */ }
  };
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* cliente ido */ } }, 15000);
  heartbeat.unref?.();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    try { res.end(); } catch { /* ya cerrado */ }
  };
  // Suscribirse ANTES de leer el snapshot: los eventos que lleguen
  // entre medias quedan en el búfer y se vuelcan después del
  // snapshot, así no se pierde ninguno.
  const buffered = [];
  let live = false;
  const off = jobsStore.subscribe(job.id, (event, data) => {
    if (!live) { buffered.push([event, data]); return; }
    if (event === '__status__') { write('__status__', data); off(); end(); return; }
    write(event, data);
  });
  req.on('close', () => { off(); clearInterval(heartbeat); });
  for (const stored of job.events) write(stored.event, stored.data);
  const bufferedStatus = buffered.find(([event]) => event === '__status__');
  for (const [event, data] of buffered) {
    if (event === '__status__') continue;
    write(event, data);
  }
  buffered.length = 0;
  live = true;
  if (jobsStore.isTerminal(job.status)) {
    write('__status__', { status: job.status, result: job.result, error: job.error });
    off();
    end();
    return;
  }
  if (bufferedStatus) {
    write('__status__', bufferedStatus[1]);
    off();
    end();
  }
});

// POST /api/jobs/:id/cancel — pide la cancelación del trabajo.
// Si aún estaba en cola, no arranca; si corría, el turno se
// detiene y el trabajo queda `cancelled`.
router.post('/jobs/:id/cancel', (req, res) => {
  const job = jobsStore.requestCancel(req.params.id, req.auth.uid);
  if (!job) return res.status(404).json({ error: 'Trabajo no encontrado.' });
  res.json({ job: jobsStore.jobSummary(job) });
});

// ─── Conversaciones (FASE 3) ──────────────────────────────────
// GET /api/threads — lista real de conversaciones del usuario.
// GET /api/threads/:id — una conversación con sus mensajes.
// POST /api/threads — crea una conversación vacía.
// PATCH /api/threads/:id — renombra ({ title }).
// DELETE /api/threads/:id — borra la conversación.
router.get('/threads', (req, res) => {
  res.json({ threads: threadsStore.listThreads(req.auth.uid) });
});

router.get('/threads/:id', (req, res) => {
  const thread = threadsStore.getThread(req.auth.uid, req.params.id);
  if (!thread) return res.status(404).json({ error: 'Conversación no encontrada.' });
  res.json({ thread });
});

router.post('/threads', (req, res) => {
  const thread = threadsStore.createThread(req.auth.uid, req.body?.title);
  if (!thread) return res.status(400).json({ error: 'No se pudo crear la conversación.' });
  res.status(201).json({ thread: threadsStore.threadSummary(thread) });
});

router.patch('/threads/:id', (req, res) => {
  const thread = threadsStore.renameThread(req.auth.uid, req.params.id, req.body?.title);
  if (!thread) return res.status(404).json({ error: 'Conversación no encontrada.' });
  res.json({ thread: threadsStore.threadSummary(thread) });
});

router.delete('/threads/:id', (req, res) => {
  if (!threadsStore.deleteThread(req.auth.uid, req.params.id)) {
    return res.status(404).json({ error: 'Conversación no encontrada.' });
  }
  res.json({ ok: true });
});

module.exports = router;

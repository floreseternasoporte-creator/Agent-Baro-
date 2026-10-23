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
const { getSession } = require('./sessionStore');
const git = require('./gitAgent');
const groq = require('./groqClient');
const ollama = require('./ollamaClient');
const { runCommand, extractAutomaticCommands, isSafeWorkspaceArgument } = require('./commandRunner');
const { extractToolCommands } = require('./toolCommands');
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
  const err = new Error(lastError ? `Ningún proveedor respondió. Último error: ${lastError.message}` : 'Ningún proveedor de IA disponible');
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
  throw new Error(`Ningún proveedor pudo generar texto: ${lastError?.message || 'desconocido'}`);
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
      reason: 'Auto-review sin veredicto claro: no aplicado automáticamente',
    };
  }
  return { approved: m[1].toUpperCase().startsWith('S'), reason };
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
      detail: 'No se detectó script test de npm, configuración/tests de pytest, go.mod ni Cargo.toml.',
    });
    session.addLog({
      type: 'info',
      title: 'Auto-test no disponible',
      detail: 'Sin runner detectable (npm/pytest/go/cargo)',
    });
    return null;
  }

  try {
    send('log', { type: 'run', title: `Verificación automática: ejecutando ${runner.label}…` });
    const res = await runCommand(runner.binary, runner.args, session.dir, 120000);
    const out = truncateCommandOutput(res.stdout || res.stderr || res.error || '(sin salida)');
    const summary = out.slice(0, 300);
    send('log', {
      type: res.ok ? 'ok' : 'err',
      title: res.ok ? 'Verificación: tests pasaron' : 'Verificación: tests fallaron',
      detail: summary,
    });
    send('verify', { ok: !!res.ok, runner: runner.label, summary });
    session.addLog({
      type: res.ok ? 'ok' : 'err',
      title: `Auto-test ${runner.label}`,
      detail: summary,
    });
    return `### Verificación automática (${runner.label}): ${res.ok ? '✅ PASARON' : '❌ FALLARON'}\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\`${res.ok ? '' : '\nCorrige los fallos con otro diff exacto y vuelve a verificar.'}`;
  } catch (e) {
    const summary = String(e.message || e).slice(0, 300);
    send('log', { type: 'err', title: 'Verificación automática falló al ejecutarse', detail: summary });
    send('verify', { ok: false, runner: runner.label, summary });
    return `### Verificación automática (${runner.label}): ❌ NO SE PUDO EJECUTAR\n${summary}`;
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
    `**Alcance:** ${statusLines.length} archivo(s) con cambios contra HEAD.`,
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
      send('log', { type: 'run', title: 'Revisando código (solo lectura)…', detail: command.focus || 'cambios contra HEAD' });
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
      return `### Video generado: "${command.prompt}"\nDuración total: ${result.totalSeconds}s en ${result.clips.length} clip(s)\n${clipList}\nVideos restantes hoy: ${result.remainingToday}`;
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
      const scopeNote = session.clientId
        ? 'Lo recordaré en futuras conversaciones, aunque cierres la app.'
        : 'Lo recordaré durante esta sesión.';
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
      let name = String(command.name || '').trim();
      if (!name) return '### Crear script\nFalta el nombre del archivo. Usa el formato: `Crear script: nombre.py :: descripcion`.';
      if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.py';
      if (name.includes('/') || name.includes('\\') || !isSafeWorkspaceArgument(name)) {
        return `### Crear script\nNombre no permitido: "${command.name}". Usa un nombre simple como \`utilidad.py\`.`;
      }
      const code = extractFencedCode(sourceText, name);
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
      send('log', { type: 'ok', title: `Script creado: ${name}`, detail: `${code.split('\n').length} lineas · ${Math.round(bytes / 1024)} KB` });
      send('computer', { mode: 'files', action: 'write', path: rel, bytes });
      session.addLog?.({ type: 'ok', title: `Script creado: ${name}`, detail: rel });
      const downloadUrl = `/api/files/download?sessionId=${encodeURIComponent(session.id)}&file=${encodeURIComponent(rel)}`;
      return `### Script creado: \`${name}\`\n${command.brief ? `_${command.brief}_\n` : ''}\n[Descargar ${name}](${downloadUrl}) — tambien quedo guardado en el workspace y listo para ejecutar.`;
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
    send('log', { type: 'err', title: `Error en herramienta (${command.tool})`, detail: e.message });
    return `### Error ejecutando herramienta "${command.tool}"\n${e.message}`;
  }
  return '';
}

function summarizeDiffResults(results) {
  return results.map((result) => {
    if (typeof result === 'string') return result; // bloque de rechazo del revisor, ya formateado
    const state = result.applied
      ? `aplicado automáticamente (${result.bytes} bytes)`
      : result.alreadyApplied
      ? 'ya estaba aplicado'
      : `no aplicado: ${result.reason}`;
    return `- ${result.path || '(sin archivo)'}: ${state}`;
  }).join('\n');
}

async function handleChatTurn(req, res) {
  const {
    sessionId,
    clientId,
    message,
    model,
    planMode,
    multiAgent,
    fileLimit,
    autoApply = true,
  } = req.body || {};
  const isPlanMode = !!planMode;
  const isMultiAgent = multiAgent === true || multiAgent === 1 || multiAgent === 'true';
  const requestedFileLimit = Number(fileLimit);
  const effectiveFileLimit = Number.isFinite(requestedFileLimit)
    ? Math.min(300, Math.max(10, Math.trunc(requestedFileLimit)))
    : 10;
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada. Recarga la app.' });
  // Vincula la memoria persistente del cliente en cada turno: así el agente
  // recuerda datos entre sesiones aunque el sessionId sea nuevo.
  if (clientId) session.setClientId(clientId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let responseClosed = false;
  let heartbeat = null;
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const send = (event, data) => {
    if (responseClosed || res.writableEnded) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      responseClosed = true;
      stopHeartbeat();
    }
  };

  const abortController = new AbortController();
  req.on('close', () => {
    responseClosed = true;
    stopHeartbeat();
    abortController.abort();
  });
  res.on('close', () => {
    responseClosed = true;
    stopHeartbeat();
  });

  if (typeof message !== 'string' || !message.trim()) {
    send('log', { type: 'err', title: 'Mensaje inválido', detail: 'Falta el texto del mensaje' });
    send('error', { error: 'Falta el mensaje: envía un texto no vacío en el campo "message".' });
    res.end();
    return;
  }

  // Heartbeat SSE: mantiene vivos los proxies/conexiones durante
  // herramientas largas (investigación, video, computadora).
  heartbeat = setInterval(() => {
    if (responseClosed || res.writableEnded) {
      stopHeartbeat();
      return;
    }
    try { res.write(': hb\n\n'); } catch { stopHeartbeat(); }
  }, 15_000);
  heartbeat.unref?.();

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
        title: 'Modo plan activo: no se aplicarán diffs ni se ejecutarán comandos',
        detail: 'Solo lectura, búsqueda y revisión; el backend bloquea cualquier escritura.',
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
        send('log', { type: 'info', title: 'Contexto general del repo', detail: `${allFiles.length} archivos` });
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
          title: 'AGENTS.md cargado',
          detail: agentsInstructions.files.join(', '),
        });
      }
    } catch (e) {
      send('log', { type: 'info', title: 'No se pudo cargar AGENTS.md', detail: e.message });
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
    await maybeCompactHistory(session, abortController.signal);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(session.history || []).slice(-14),
      { role: 'user', content: enrichedMessage },
    ];

    send('log', { type: 'run', title: 'Generando respuesta...', detail: 'buscando proveedor disponible' });

    // NOTA DE RENDIMIENTO: antes cada evento 'delta' llevaba el TEXTO
    // COMPLETO acumulado (O(n²) de red por respuesta). Ahora solo viaja
    // el fragmento nuevo y el frontend lo acumula — el stream es de
    // verdad en tiempo real, sin reenviar megabytes.
    let result = await streamWithFailover({
      model,
      messages,
      signal: abortController.signal,
      onDelta: (delta) => send('delta', { delta }),
      onProvider: (name) => send('log', { type: 'info', title: `Respondiendo con ${name}`, detail: model || 'modelo por defecto' }),
    });

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
        const toolName = userToolCommands[i].tool;
        send('log', {
          type: 'info',
          title: `Modo plan: herramienta no ejecutada (${toolName})`,
          detail: 'Solo se permiten herramientas de lectura y búsqueda',
        });
        preToolTexts[i] = `### Herramienta no ejecutada por modo plan\nLa herramienta "${toolName}" genera o modifica contenido. En modo plan Baro solo usa lectura, búsqueda y revisión de código; no se ejecutó ninguna acción.`;
      }
      // El texto fuente para las herramientas de los comandos del
      // usuario incluye la RESPUESTA del modelo: "Crear script" busca
      // ahí el bloque de código cercado que la IA acaba de escribir.
      // (Antes se pasaba solo el mensaje del usuario y el script
      // nunca encontraba el código aunque la IA lo hubiera dado.)
      const preToolSource = `${visibleResult || ''}\n${message}`;
      for (const i of preComputerIdx) {
        preToolTexts[i] = await runToolCommand(userToolCommands[i], send, session, abortController.signal, preToolSource);
      }
      if (preRestIdx.length) {
        if (isMultiAgent && preRestIdx.length > 1) {
          send('log', { type: 'info', title: `Modo multi-agente: ${preRestIdx.length} acciones en paralelo` });
        }
        const rest = await Promise.all(
          preRestIdx.map((i) => runToolCommand(userToolCommands[i], send, session, abortController.signal, preToolSource))
        );
        preRestIdx.forEach((origI, k) => { preToolTexts[origI] = rest[k]; });
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
            title: 'Modo plan: diff no aplicado automáticamente',
            detail: 'El backend bloquea la escritura hasta salir del modo plan',
          });
          diffResults.push(`### Diff NO aplicado por modo plan\nEl diff queda solo como propuesta para revisión manual; el backend no escribió ningún archivo.\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
          appliedDiffs.push({
            diff: diffKey,
            applied: false,
            paths: [],
            reason: 'Modo plan activo: aplicación bloqueada por el backend',
            alreadyApplied: false,
          });
        }
      }
      if (autoApply && !isPlanMode && session.repoFullName) {
        const diffBlocks = git.extractDiffBlocks(result);
        for (const diffBlock of diffBlocks) {
          const diffKey = diffBlock.trim();
          if (!diffKey || seenDiffs.has(diffKey)) continue;
          seenDiffs.add(diffKey);
          // ── Auto-review estilo Astra: segundo pase del modelo como
          // revisor ANTES de tocar el disco. Un rechazo no rompe el
          // turno: el motivo vuelve al loop y el agente lo corrige.
          send('log', { type: 'run', title: 'Revisando cambio antes de aplicarlo…' });
          let review = { approved: false, unclear: true, reason: 'Auto-review sin veredicto claro: no aplicado automáticamente' };
          try {
            review = await reviewDiffWithAI(diffBlock, (p) => generateText(p, abortController.signal));
          } catch (e) {
            review = {
              approved: false,
              unclear: true,
              reason: `Auto-review sin veredicto claro: no aplicado automáticamente (revisor no disponible: ${e.message})`,
            };
          }
          if (!review.approved) {
            if (review.unclear) {
              send('log', {
                type: 'info',
                title: 'Auto-review sin veredicto claro: no aplicado automáticamente',
                detail: review.reason,
              });
              session.addLog({ type: 'info', title: 'Diff no auto-aplicado por auto-review incierto', detail: review.reason });
              diffResults.push(`### Diff NO auto-aplicado por revisión incierta\n${review.reason}. El diff queda disponible como propuesta normal para aplicación manual; no afirmes que fue aplicado.\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
              appliedDiffs.push({ diff: diffKey, applied: false, paths: [], reason: review.reason, alreadyApplied: false });
              continue;
            }
            const reason = `Rechazado por revisión automática: ${review.reason}`;
            send('log', { type: 'err', title: 'Cambio rechazado por el revisor', detail: review.reason });
            session.addLog({ type: 'err', title: 'Diff rechazado por auto-review', detail: review.reason });
            diffResults.push(`### Diff RECHAZADO por el revisor (NO aplicado)\n${reason}\nCorrige el diff y vuelve a intentarlo.\n\`\`\`diff\n${diffKey.slice(0, 2000)}\n\`\`\``);
            appliedDiffs.push({ diff: diffKey, applied: false, paths: [], reason, alreadyApplied: false });
            continue;
          }
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
        const toolName = requestedTools[i].tool;
        send('log', {
          type: 'info',
          title: `Modo plan: herramienta no ejecutada (${toolName})`,
          detail: 'Solo se permiten herramientas de lectura y búsqueda',
        });
        roundToolTexts[i] = `### Herramienta no ejecutada por modo plan\nLa herramienta "${toolName}" genera o modifica contenido y quedó bloqueada por el backend.`;
      }
      for (const i of computerIdx) {
        roundToolTexts[i] = await runToolCommand(requestedTools[i], send, session, abortController.signal, result);
      }
      if (restIdx.length) {
        if (isMultiAgent && restIdx.length > 1) {
          send('log', { type: 'info', title: `Modo multi-agente: ${restIdx.length} acciones en paralelo` });
        }
        const rest = await Promise.all(
          restIdx.map((i) => runToolCommand(requestedTools[i], send, session, abortController.signal, result))
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
          detail: 'El backend bloquea Ejecuta: en modo plan',
        });
        commandResults.push([
          '## Comandos NO ejecutados por modo plan',
          ...commands.map((command) => `- ${command.display}: bloqueado por el backend (modo plan)`),
        ].join('\n'));
        executableCommands = [];
      }

      const executeAutomaticCommand = async (command) => {
        const title = `Ejecutando automáticamente: ${command.display}`;
        send('log', { type: 'run', title });
        send('computer', { mode: 'terminal', action: 'run', command: command.display });
        session.addLog({ type: 'run', title });

        const commandResult = await runCommand(command.binary, command.args, session.dir);
        const output = truncateCommandOutput(commandResult.stdout || commandResult.stderr || commandResult.error);
        const logEntry = {
          type: commandResult.ok ? 'ok' : 'err',
          title: commandResult.ok ? `Completado: ${command.display}` : `Falló: ${command.display}`,
          detail: output,
        };
        send('log', logEntry);
        send('computer', { mode: 'terminal', action: 'output', text: output || (commandResult.ok ? '(sin salida)' : 'error'), ok: commandResult.ok });
        session.addLog(logEntry);
        return commandResultForModel(command, commandResult);
      };

      if (isMultiAgent && executableCommands.length > 1) {
        send('log', { type: 'info', title: `Modo multi-agente: ${executableCommands.length} acciones en paralelo` });
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

      result = await streamWithFailover({
        model,
        messages: conversation,
        signal: abortController.signal,
        onDelta: (delta) => send('delta', { delta }),
        onProvider: (name) => send('log', { type: 'info', title: `Continuando con ${name}` }),
      });
      const previous = visibleResult;
      visibleResult = `${previous}\n\n${result}`;
    }

    if (visibleResult !== result) result = visibleResult;

    session.history = session.history || [];
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'assistant', content: result });

    const diffBlocks = git.extractDiffBlocks(result);
    sendPlan(null, true);
    send('log', { type: 'ok', title: 'Completado', detail: diffBlocks.length ? `${diffBlocks.length} diff(s) propuesto(s)` : undefined });
    send('done', { text: result, diffCount: diffBlocks.length, autoAppliedPaths, appliedDiffs });
    stopHeartbeat();
    res.end();
  } catch (e) {
    if (e.name === 'AbortError') {
      send('log', { type: 'info', title: 'Detenido por el usuario' });
      send('done', { text: '', aborted: true });
    } else {
      send('log', { type: 'err', title: 'Error', detail: e.message });
      send('error', { error: e.message });
    }
    stopHeartbeat();
    res.end();
  }
}

router.post('/chat', async (req, res) => {
  const lockKey = String(req.body?.sessionId || '__sin_sesion__');
  const previous = chatTurnChains.get(lockKey) || Promise.resolve();
  let releaseCurrent;
  const currentGate = new Promise((resolve) => { releaseCurrent = resolve; });
  const queuedTurn = previous.catch(() => {}).then(() => currentGate);
  chatTurnChains.set(lockKey, queuedTurn);

  await previous.catch(() => {});
  try {
    await handleChatTurn(req, res);
  } finally {
    releaseCurrent();
    if (chatTurnChains.get(lockKey) === queuedTurn) {
      chatTurnChains.delete(lockKey);
    }
  }
});

module.exports = router;

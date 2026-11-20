// ═══════════════════════════════════════════════════════
// envSetup.js
// Entorno reproducible por repo estilo Codex (H6): al conectar
// un repo, Baro detecta el comando de setup (npm ci / pip
// install -r requirements.txt / ...) y el comando de tests, los
// ejecuta UNA vez por sesión y guarda el healthcheck. Si el
// entorno está roto, el usuario lo sabe ANTES del primer turno,
// no a mitad de la tarea.
//
// La convención que lee es la del propio repo: secciones
// `## Setup` y `## Testing` de su AGENTS.md (o de los
// manifiestos: package.json, requirements.txt, pyproject.toml,
// go.mod, Cargo.toml). Nunca se instalan dependencias sin que
// el comando venga del repo o de sus manifiestos, y todo corre
// por la lista blanca de commandRunner (sin shell, con timeout).
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { runCommand, parseCommandLine } = require('./commandRunner');

const SETUP_TIMEOUT_MS = 600_000; // installs: hasta 10 min
const TEST_TIMEOUT_MS = 120_000;

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(file, maxBytes) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return maxBytes ? content.slice(0, maxBytes) : content;
  } catch {
    return '';
  }
}

// Extrae el primer comando de una sección `## Setup` / `## Testing`
// de un texto AGENTS.md (línea con backticks o comando pelado).
function sectionCommand(text, heading) {
  const src = String(text || '');
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/^##\s+/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s*/, '');
    const code = /`([^`]+)`/.exec(line);
    const candidate = (code ? code[1] : line).trim();
    if (/^(npm|npx|node|pip3?|python3?|pytest|go|cargo|yarn)\b/i.test(candidate)) return candidate;
  }
  return null;
}

/** Lee `## Setup` y `## Testing` de un AGENTS.md. Puro y testeable. */
function parseAgentsSetup(text) {
  return { setup: sectionCommand(text, 'Setup'), test: sectionCommand(text, 'Testing') };
}

/**
 * Detecta setup + tests de un repo clonado en `dir`.
 * Devuelve { setupCommands: string[], testCommand: string|null, source, languages }.
 * El AGENTS.md del repo manda sobre los manifiestos.
 */
async function detectEnv(dir) {
  const setupCommands = [];
  const languages = [];
  let testCommand = null;
  let source = 'manifiestos';

  const pkg = readJsonIfExists(path.join(dir, 'package.json'));
  const pyproject = readTextIfExists(path.join(dir, 'pyproject.toml'), 8000);
  const hasRequirements = fs.existsSync(path.join(dir, 'requirements.txt'));
  const hasGoMod = fs.existsSync(path.join(dir, 'go.mod'));
  const hasCargo = fs.existsSync(path.join(dir, 'Cargo.toml'));
  const hasPytestConfig = fs.existsSync(path.join(dir, 'pytest.ini'))
    || fs.existsSync(path.join(dir, 'tox.ini'))
    || /\[tool\.pytest/.test(pyproject)
    || (fs.existsSync(path.join(dir, 'setup.cfg')) && /\[tool:pytest\]/.test(readTextIfExists(path.join(dir, 'setup.cfg'), 4000)));

  if (pkg) {
    languages.push('Node.js');
    if (pkg.scripts?.setup) setupCommands.push('npm run setup');
    else setupCommands.push(fs.existsSync(path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install');
    if (pkg.scripts?.test) testCommand = 'npm test';
  }
  if (pyproject || hasRequirements) {
    languages.push('Python');
    if (hasRequirements) setupCommands.push('pip install -r requirements.txt');
    else if (pyproject) setupCommands.push('pip install -e .');
    if (!testCommand && (hasPytestConfig || hasRequirements)) testCommand = 'python3 -m pytest -q';
  }
  if (hasGoMod) {
    languages.push('Go');
    setupCommands.push('go mod download');
    if (!testCommand) testCommand = 'go test ./...';
  }
  if (hasCargo) {
    languages.push('Rust');
    setupCommands.push('cargo fetch');
    if (!testCommand) testCommand = 'cargo test';
  }

  // Convención AGENTS.md: sus secciones mandan sobre lo detectado.
  let agentsText = '';
  try {
    const agentsMd = require('./agentsMd');
    const loaded = await agentsMd.loadAgentsInstructions(dir);
    agentsText = loaded.text || '';
  } catch {}
  if (agentsText) {
    const parsed = parseAgentsSetup(agentsText);
    if (parsed.setup) {
      setupCommands.length = 0;
      setupCommands.push(parsed.setup);
      source = 'AGENTS.md';
    }
    if (parsed.test) {
      testCommand = parsed.test;
      source = 'AGENTS.md';
    }
  }

  return { setupCommands, testCommand, source, languages };
}

function summarize(result, command) {
  const out = String(result.stdout || result.stderr || result.error || '').trim();
  return out ? out.slice(0, 300) : '(sin salida)';
}

/**
 * Ejecuta setup + healthcheck de tests UNA vez por sesión.
 * Guarda el resultado en session.envHealth y lo devuelve.
 * Nunca lanza: si algo falla, devuelve ok:false con el motivo.
 * `send` es opcional (logs SSE cuando hay turno en curso).
 */
async function runEnvSetup(session, send, { force = false } = {}) {
  if (session.envHealth && session.envHealth.status === 'done' && !force) {
    return session.envHealth;
  }
  const startedAt = Date.now();
  session.envHealth = { status: 'running', startedAt };
  const log = (entry) => {
    try { session.addLog?.(entry); } catch {}
    try { send?.('log', entry); } catch {}
  };
  try {
    const detected = await detectEnv(session.dir);
    if (!detected.setupCommands.length && !detected.testCommand) {
      const health = {
        status: 'done', ok: true, at: startedAt,
        setup: [], test: null,
        detail: 'Sin setup ni tests detectables en este repo (sin package.json, requirements.txt, go.mod ni Cargo.toml).',
        source: detected.source, languages: detected.languages,
      };
      session.envHealth = health;
      return health;
    }
    log({ type: 'info', title: 'Preparando el entorno del repo…', detail: `setup: ${detected.setupCommands.join(' && ') || 'ninguno'} · tests: ${detected.testCommand || 'ninguno'} (${detected.source})` });
    const setupResults = [];
    let setupOk = true;
    for (const commandLine of detected.setupCommands) {
      const parsed = parseCommandLine(commandLine);
      if (!parsed) {
        setupResults.push({ command: commandLine, ok: false, summary: 'Comando de setup no interpretable' });
        setupOk = false;
        break;
      }
      const res = await runCommand(parsed.binary, parsed.args, session.dir, SETUP_TIMEOUT_MS);
      const summary = summarize(res, commandLine);
      setupResults.push({ command: commandLine, ok: !!res.ok, summary });
      log({ type: res.ok ? 'ok' : 'err', title: res.ok ? `Setup OK: ${commandLine}` : `Setup falló: ${commandLine}`, detail: summary });
      if (!res.ok) { setupOk = false; break; }
    }
    let testResult = null;
    if (setupOk && detected.testCommand) {
      const parsed = parseCommandLine(detected.testCommand);
      if (parsed) {
        const res = await runCommand(parsed.binary, parsed.args, session.dir, TEST_TIMEOUT_MS);
        testResult = { command: detected.testCommand, ok: !!res.ok, summary: summarize(res, detected.testCommand) };
        log({ type: res.ok ? 'ok' : 'err', title: res.ok ? `Healthcheck: tests en verde (${detected.testCommand})` : `Healthcheck: tests en rojo (${detected.testCommand})`, detail: testResult.summary });
      }
    }
    const health = {
      status: 'done',
      ok: setupOk && (!testResult || testResult.ok),
      at: startedAt,
      setup: setupResults,
      test: testResult,
      source: detected.source,
      languages: detected.languages,
      detail: !setupOk
        ? 'El setup del entorno falló: revisa el log antes de pedir cambios de código.'
        : testResult && !testResult.ok
          ? 'El entorno se instaló pero los tests no pasan en vacío: el repo llega con tests en rojo.'
          : 'Entorno listo: setup y tests verificados.',
    };
    session.envHealth = health;
    return health;
  } catch (e) {
    const health = { status: 'done', ok: false, at: startedAt, setup: [], test: null, detail: `No se pudo preparar el entorno: ${e.message}` };
    session.envHealth = health;
    log({ type: 'err', title: 'Error preparando el entorno', detail: e.message });
    return health;
  }
}

module.exports = {
  SETUP_TIMEOUT_MS,
  TEST_TIMEOUT_MS,
  parseAgentsSetup,
  sectionCommand,
  detectEnv,
  runEnvSetup,
};

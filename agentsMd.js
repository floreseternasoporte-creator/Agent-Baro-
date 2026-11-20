// ═══════════════════════════════════════════════════════
// agentsMd.js
// Soporte estilo Codex para AGENTS.md: instrucciones del
// propio proyecto que el agente debe respetar en cada turno.
//
// Reglas de carga:
// - AGENTS.override.md de la raíz sustituye a AGENTS.md de
//   la raíz (el override gana).
// - .agents/AGENTS.md se añade después, si existe.
// - El texto combinado nunca supera 32 KB.
// ═══════════════════════════════════════════════════════

const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');

const MAX_AGENTS_MD_BYTES = 32 * 1024;

async function readIfExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function truncateToBytes(text, maxBytes) {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '\n\n[AGENTS.md truncado al límite de 32 KB]';
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= contentBudget) low = mid;
    else high = mid - 1;
  }
  return `${value.slice(0, low).trimEnd()}${marker}`;
}

/**
 * Carga las instrucciones AGENTS.md visibles desde la raíz
 * del workspace. Devuelve siempre { text, files } y nunca
 * lanza por archivos ausentes o ilegibles.
 */
async function loadAgentsInstructions(dir) {
  const root = path.resolve(String(dir || ''));
  const files = [];
  const sections = [];

  const override = await readIfExists(path.join(root, 'AGENTS.override.md'));
  const rootAgents = override === null
    ? await readIfExists(path.join(root, 'AGENTS.md'))
    : null;

  if (override !== null) {
    files.push('AGENTS.override.md');
    sections.push(override.trim());
  } else if (rootAgents !== null) {
    files.push('AGENTS.md');
    sections.push(rootAgents.trim());
  }

  const nested = await readIfExists(path.join(root, '.agents', 'AGENTS.md'));
  if (nested !== null) {
    files.push('.agents/AGENTS.md');
    sections.push(nested.trim());
  }

  const text = truncateToBytes(sections.filter(Boolean).join('\n\n'), MAX_AGENTS_MD_BYTES);
  return { text, files };
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fss.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(filePath, maxChars = 12000) {
  try {
    return fss.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch {
    return '';
  }
}

function listTopLevel(dir) {
  try {
    return fss.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 80)
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name);
  } catch {
    return [];
  }
}

function scriptCommand(pkg, names) {
  if (!pkg?.scripts) return null;
  for (const name of names) {
    if (pkg.scripts[name]) return `npm run ${name}`;
  }
  return null;
}

/**
 * Genera un esqueleto de AGENTS.md analizando el workspace.
 * No escribe en disco: devuelve el contenido para que la capa
 * de rutas (/init) decida cuándo y dónde guardarlo.
 */
function buildAgentsMdSkeleton(dir) {
  const root = path.resolve(String(dir || ''));
  const pkg = readJsonIfExists(path.join(root, 'package.json'));
  const pyproject = readTextIfExists(path.join(root, 'pyproject.toml'));
  const goMod = readTextIfExists(path.join(root, 'go.mod'), 2000);
  const cargoToml = readTextIfExists(path.join(root, 'Cargo.toml'), 4000);
  const hasRequirements = fss.existsSync(path.join(root, 'requirements.txt'));
  const hasPyTests = [
    'pytest.ini', 'tox.ini', 'tests', 'test',
  ].some((name) => fss.existsSync(path.join(root, name)))
    || /\[tool\.pytest/.test(pyproject)
    || hasRequirements;

  let projectName = path.basename(root);
  if (pkg?.name) projectName = String(pkg.name);
  else {
    const cargoName = /^\s*name\s*=\s*"([^"]+)"/m.exec(cargoToml);
    const goName = /^\s*module\s+(\S+)/m.exec(goMod);
    const pyName = /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject);
    if (cargoName) projectName = cargoName[1];
    else if (goName) projectName = goName[1];
    else if (pyName) projectName = pyName[1];
  }

  const stack = [];
  if (pkg) stack.push('Node.js / JavaScript');
  if (pyproject || hasRequirements) stack.push('Python');
  if (goMod) stack.push('Go');
  if (cargoToml) stack.push('Rust');

  const testCommand = pkg?.scripts?.test
    ? 'npm test'
    : hasPyTests
    ? 'python3 -m pytest -q'
    : goMod
    ? 'go test ./...'
    : cargoToml
    ? 'cargo test'
    : null;
  const lintCommand = scriptCommand(pkg, ['lint', 'check']);
  const buildCommand = scriptCommand(pkg, ['build']);
  // H6: comando de setup canónico (lo lee envSetup.js al conectar).
  const setupCommand = pkg?.scripts?.setup
    ? 'npm run setup'
    : pkg
    ? (fss.existsSync(path.join(root, 'package-lock.json')) ? 'npm ci' : 'npm install')
    : hasRequirements
    ? 'pip install -r requirements.txt'
    : goMod
    ? 'go mod download'
    : cargoToml
    ? 'cargo fetch'
    : null;
  const topLevel = listTopLevel(root);

  const lines = [
    '# AGENTS.md',
    '',
    '## Proyecto',
    `- Nombre: ${projectName}`,
    `- Stack detectado: ${stack.length ? stack.join(', ') : 'no determinado automáticamente'}`,
    '',
    '## Estructura principal',
    ...(topLevel.length ? topLevel.map((entry) => `- \`${entry}\``) : ['- (sin estructura detectable)']),
    '',
    '## Comandos del proyecto',
    `- Tests: ${testCommand ? `\`${testCommand}\`` : 'no detectado; añade aquí el comando real de tests'}`,
    `- Lint: ${lintCommand ? `\`${lintCommand}\`` : 'no detectado'}`,
    `- Build: ${buildCommand ? `\`${buildCommand}\`` : 'no detectado'}`,
    '',
    '## Setup',
    `- Instalar dependencias: ${setupCommand ? `\`${setupCommand}\`` : 'no detectado; añade aquí el comando real de instalación'}`,
    '',
    '## Testing',
    `- Ejecutar tests: ${testCommand ? `\`${testCommand}\`` : 'no detectado; añade aquí el comando real de tests'}`,
    '',
    '## Reglas para agentes',
    '- Lee el código existente antes de editar y sigue sus convenciones.',
    '- Haz cambios pequeños y quirúrgicos; no reescribas archivos completos sin necesidad.',
    '- Ejecuta los tests relevantes después de cada cambio y reporta el resultado real.',
    '- No hagas push, despliegues ni cambios destructivos sin confirmación explícita.',
    '- Si una instrucción de este archivo entra en conflicto con una petición actual, pide confirmación.',
    '',
  ];
  return lines.join('\n');
}

module.exports = {
  MAX_AGENTS_MD_BYTES,
  loadAgentsInstructions,
  buildAgentsMdSkeleton,
};

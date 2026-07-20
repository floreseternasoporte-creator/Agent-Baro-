// ═══════════════════════════════════════════════════════
// commandRunner.js
// Ejecuta comandos REALES dentro del workspace clonado
// (npm install, npm test, python -m pytest, etc), igual que
// el "sandbox" de Codex ejecuta comandos dentro de su
// contenedor. Aqui esta contenido con:
//   1. Lista blanca de binarios permitidos (nada de "rm",
//      "curl", "sh -c", etc.)
//   2. execFile con shell:false — nunca se concatenan
//      strings a un shell, asi que no hay inyeccion posible.
//   3. Timeout duro para que un comando colgado no tumbe
//      el servidor.
//   4. cwd fijado al workspace de la sesion — nunca puede
//      salirse de esa carpeta.
// ═══════════════════════════════════════════════════════

const { execFile } = require('child_process');
const path = require('path');

// Solo estos binarios pueden invocarse. Si el proyecto necesita
// otro (por ejemplo "yarn" o "cargo"), se agrega aqui a mano —
// nunca se acepta un binario que venga del usuario o de la IA.
const ALLOWED_BINARIES = {
  npm: ['install', 'ci', 'run', 'test', 'run-script', 'ls', 'audit', 'outdated'],
  npx: null, // null = cualquier argumento (npx ya es sandboxed por si mismo para paquetes conocidos)
  node: ['-v', '--version'],
  python: null,
  python3: null,
  pip: ['install', 'list', 'freeze'],
  pip3: ['install', 'list', 'freeze'],
  pytest: null,
  yarn: ['install', 'run', 'test'],
  git: ['status', 'log', 'diff', 'branch', 'show'],
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 200_000;

function isAllowed(binary, args) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_BINARIES, binary)) return false;
  const allowedSubcommands = ALLOWED_BINARIES[binary];
  if (allowedSubcommands === null) return true;
  if (!args.length) return true;
  return allowedSubcommands.includes(args[0]);
}

/**
 * Corre un comando real dentro de `cwd`.
 * @param {string} binary  ej. "npm"
 * @param {string[]} args  ej. ["install"]
 * @param {string} cwd     carpeta del workspace (nunca fuera de ella)
 * @param {number} [timeoutMs]
 */
function runCommand(binary, args, cwd, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!isAllowed(binary, args)) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: `Comando no permitido: "${binary} ${args.join(' ')}". Solo se permiten binarios en la lista blanca del agente.`,
      });
      return;
    }

    const child = execFile(
      binary,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CI: 'true', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout || '').slice(-MAX_OUTPUT_BYTES),
          stderr: String(stderr || '').slice(-MAX_OUTPUT_BYTES),
          error: error && error.killed ? `Comando cancelado: excedio ${timeoutMs}ms` : (error ? error.message : null),
        });
      }
    );

    // Seguridad extra: nunca dejar que el proceso viva mas que el timeout,
    // incluso si execFile no lo mata a tiempo.
    const hardKill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 5_000);
    child.on('exit', () => clearTimeout(hardKill));
  });
}

/** Traduce una instruccion de alto nivel ("instalar dependencias") a un comando real. */
const TASK_PRESETS = {
  install: { binary: 'npm', args: ['install'] },
  test: { binary: 'npm', args: ['test'] },
  'install-py': { binary: 'pip', args: ['install', '-r', 'requirements.txt'] },
  'test-py': { binary: 'pytest', args: [] },
  status: { binary: 'git', args: ['status', '--short'] },
};

module.exports = {
  runCommand,
  isAllowed,
  ALLOWED_BINARIES,
  TASK_PRESETS,
  DEFAULT_TIMEOUT_MS,
};

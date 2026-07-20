// ═══════════════════════════════════════════════════════
// gitAgent.js
// Todo lo que toca disco y git de verdad. Nada de esto es
// simulado: clona el repo real, lee y escribe archivos
// reales, y aplica los diffs que genera la IA sobre el
// contenido real del archivo (usando la libreria "diff",
// el mismo tipo de parser que usan herramientas como
// patch-package). Asi el push nunca sube contenido vacio.
// ═══════════════════════════════════════════════════════

const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const { applyPatch, parsePatch } = require('diff');

const IGNORED_DIR_RE = /^(node_modules|\.git|dist|build|\.next|coverage|vendor|\.cache|\.parcel-cache|__pycache__|\.venv|venv)$/i;
const IGNORED_EXT_RE = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz|lock|bin|exe|dll)$/i;

function parseRepoUrl(url) {
  const match = String(url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function authedRemote(owner, repo, token) {
  if (token) {
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Clona (o re-sincroniza) un repo real en session.dir.
 * Si la carpeta ya existe con ese repo, hace fetch+reset en vez
 * de re-clonar todo, para que reconectar sea rapido.
 */
async function cloneRepo({ dir, owner, repo, branch, token }) {
  const remote = authedRemote(owner, repo, token);

  if (fss.existsSync(path.join(dir, '.git'))) {
    const git = simpleGit(dir);
    await git.remote(['set-url', 'origin', remote]);
    await git.fetch('origin', branch);
    await git.checkout(branch);
    await git.reset(['--hard', `origin/${branch}`]);
    return git;
  }

  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit();
  await git.clone(remote, dir, ['--branch', branch, '--single-branch', '--depth', '50']);
  return simpleGit(dir);
}

/** Lista archivos de texto del repo clonado, ignorando binarios/carpetas pesadas. */
async function listFiles(dir) {
  const results = [];

  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (IGNORED_DIR_RE.test(entry.name)) continue;
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile() && !IGNORED_EXT_RE.test(entry.name)) {
        results.push(relPath);
      }
    }
  }

  await walk(dir, '');
  return results.sort();
}

function safeResolve(dir, relPath) {
  const resolved = path.resolve(dir, relPath);
  if (!resolved.startsWith(path.resolve(dir))) {
    throw new Error('Ruta fuera del workspace no permitida');
  }
  return resolved;
}

async function readFile(dir, relPath) {
  const abs = safeResolve(dir, relPath);
  return fs.readFile(abs, 'utf8');
}

async function writeFile(dir, relPath, content) {
  const abs = safeResolve(dir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Aplica un parche unified-diff real sobre el archivo real en disco.
 * Devuelve {applied, newContent, reason}. Nunca escribe contenido
 * vacio: si el patch no calza contra el archivo actual, falla con
 * un motivo claro en vez de borrar el archivo.
 */
async function applyUnifiedDiff(dir, diffText) {
  const patches = parsePatch(diffText);
  const results = [];

  for (const patch of patches) {
    const targetPath = (patch.newFileName || patch.oldFileName || '')
      .replace(/^[ab]\//, '')
      .trim();
    if (!targetPath) {
      results.push({ path: null, applied: false, reason: 'No se pudo determinar el archivo del diff' });
      continue;
    }

    const abs = safeResolve(dir, targetPath);
    let original = '';
    let isNewFile = false;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch {
      isNewFile = true; // el diff puede estar creando un archivo nuevo
    }

    const patched = applyPatch(original, patch);
    if (patched === false) {
      results.push({
        path: targetPath,
        applied: false,
        reason: isNewFile
          ? 'El diff no coincide y el archivo no existe todavia'
          : 'El diff no coincide con el contenido actual del archivo (puede haber cambiado desde que la IA lo leyo)',
      });
      continue;
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, patched, 'utf8');
    results.push({ path: targetPath, applied: true, bytes: patched.length });
  }

  return results;
}

/** Extrae todos los bloques ```diff ...``` de un texto de la IA. */
function extractDiffBlocks(text) {
  const blocks = [];
  const re = /```diff\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push(m[1]);
  }
  return blocks;
}

async function commitAndPush({ dir, message, branch, name, email }) {
  const git = simpleGit(dir);
  await git.addConfig('user.name', name || 'DevAgent');
  await git.addConfig('user.email', email || 'devagent@users.noreply.github.com');

  const status = await git.status();
  const changed = [...status.modified, ...status.not_added, ...status.created, ...status.deleted];
  if (!changed.length) {
    return { pushed: false, reason: 'No hay cambios para subir', files: [] };
  }

  await git.add(changed);
  await git.commit(message || 'update via DevAgent');
  await git.push('origin', branch);

  return { pushed: true, files: changed };
}

async function diffAgainstHead(dir, relPath) {
  const git = simpleGit(dir);
  try {
    return await git.diff(['HEAD', '--', relPath]);
  } catch {
    return '';
  }
}

module.exports = {
  parseRepoUrl,
  cloneRepo,
  listFiles,
  readFile,
  writeFile,
  applyUnifiedDiff,
  extractDiffBlocks,
  commitAndPush,
  diffAgainstHead,
};

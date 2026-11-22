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
const { applyPatch, parsePatch, reversePatch } = require('diff');

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

/** Remoto LIMPIO (sin token): el único que debe quedar en .git/config. */
function cleanRemote(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Deja el remoto `origin` sin token. El token solo vive en memoria
 * durante fetch/push concretos; NUNCA queda persistido en
 * .git/config (antes quedaba en claro en cada workspace y la ruta
 * de descarga de archivos podía servir ese .git/config).
 */
async function setCleanRemote(git, owner, repo) {
  try {
    await git.remote(['set-url', 'origin', cleanRemote(owner, repo)]);
  } catch {
    try { await git.addRemote('origin', cleanRemote(owner, repo)); } catch {}
  }
}

/**
 * Clona (o re-sincroniza) un repo real en session.dir.
 * Si la carpeta ya existe con ese repo, hace fetch+reset en vez
 * de re-clonar todo, para que reconectar sea rapido.
 *
 * Baro v6 (seguridad):
 *  - El remoto con token se usa SOLO en memoria durante el
 *    fetch/clone y al terminar queda el remoto LIMPIO en disco.
 *  - Reconectar ya NO destruye trabajo: si hay cambios sin
 *    pushear, primero se guardan en un checkpoint automático
 *    (`git stash push -u`) y solo entonces se resetea. Si el
 *    checkpoint falla, NO se resetea: se lanza un error claro.
 *
 * Devuelve { git, fresh, reconnected, checkpoint, stashRef } —
 * checkpoint=true si se guardó trabajo previo al reconectar.
 */
async function cloneRepo({ dir, owner, repo, branch, token }) {
  const remote = authedRemote(owner, repo, token);

  if (fss.existsSync(path.join(dir, '.git'))) {
    const git = simpleGit(dir);
    let checkpoint = false;
    let stashRef = null;
    try {
      await git.remote(['set-url', 'origin', remote]);
      await git.fetch('origin', branch);
      await git.checkout(branch);

      // ¿Hay trabajo local sin pushear? No destruirlo jamás.
      const status = await git.status();
      const dirty = status.files && status.files.length > 0;
      if (dirty) {
        const label = `baro-checkpoint-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        try {
          await git.stash(['push', '-u', '-m', label]);
        } catch (stashError) {
          throw new Error(
            `No se pudo guardar el trabajo sin pushear antes de reconectar (${stashError.message}). ` +
            'Reconexión abortada para no perder cambios.'
          );
        }
        stashRef = 'stash@{0}';
        checkpoint = true;
      }

      await git.reset(['--hard', `origin/${branch}`]);
      return { git, fresh: false, reconnected: true, checkpoint, stashRef };
    } finally {
      // Pase lo que pase, el remoto en disco queda SIN token.
      await setCleanRemote(git, owner, repo);
    }
  }

  await fs.mkdir(dir, { recursive: true });
  const cloner = simpleGit();
  await cloner.clone(remote, dir, ['--branch', branch, '--single-branch', '--depth', '50']);
  const git = simpleGit(dir);
  await setCleanRemote(git, owner, repo);
  return { git, fresh: true, reconnected: false, checkpoint: false, stashRef: null };
}

/** Lista archivos de texto del repo clonado, ignorando binarios/carpetas pesadas. */
async function listFiles(dir) {
  const results = [];

  async function walk(current, rel) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      // Baro v6: el agente SÍ ve los dotfiles del proyecto (.github/,
      // .gitignore, .eslintrc, .editorconfig...) — antes no veía nada
      // de la configuración real del repo. Excepciones duras:
      //  - `.git` (directorio o archivo): nunca (IGNORED_DIR_RE + check).
      //  - `.env*`: nunca se expone un .env real; solo `.env.example`.
      if (entry.name === '.git') continue;
      if (/^\.env($|\.)/.test(entry.name) && entry.name !== '.env.example') continue;
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
  const root = path.resolve(dir);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
function comparableLine(line) {
  // Los modelos suelen cambiar espacios al final de una línea al copiar
  // código. Eso no cambia el código y no debe invalidar un parche entero.
  return String(line ?? '').replace(/[ \t]+$/, '');
}

function patchTargetPath(patch) {
  const oldName = String(patch.oldFileName || '').trim();
  const newName = String(patch.newFileName || '').trim();
  // En un diff de borrado el nombre útil está en ---; en uno nuevo, en +++.
  const selected = newName === '/dev/null' ? oldName : oldName === '/dev/null' ? newName : newName || oldName;
  return selected.replace(/^[ab]\//, '').trim();
}

function hasDeletions(patch) {
  return patch.hunks.some((hunk) => hunk.lines.some((line) => line[0] === '-'));
}

function applyPatchSafely(source, patch, retryPatch) {
  // Primero exigimos una coincidencia exacta. La mayoría de los diffs pasan
  // por aquí y conserva exactamente los finales de línea del archivo real.
  const exact = applyPatch(source, patch);
  if (exact !== false) return exact;

  // Segundo intento: permitimos únicamente diferencias de espacios al final
  // y hasta tres líneas de contexto desplazadas. Nunca permitimos que falte
  // una línea que el diff pretende borrar; de lo contrario podríamos duplicar
  // código silenciosamente.
  if (!hasDeletions(patch)) return false;
  let invalidDeletion = false;
  const tolerant = applyPatch(source, retryPatch || patch, {
    fuzzFactor: 3,
    compareLine: (_lineNumber, line, operation, patchContent) => {
      const same = comparableLine(line) === comparableLine(patchContent);
      if (operation === '-' && !same) invalidDeletion = true;
      return same;
    },
  });
  return invalidDeletion || tolerant === false ? false : tolerant;
}

function reversePatchSafely(source, patch) {
  const reversed = reversePatch(patch);
  const exact = applyPatch(source, reversed);
  if (exact !== false) return true;
  if (!hasDeletions(reversed)) return false;

  let invalidDeletion = false;
  const tolerant = applyPatch(source, reversePatch(patch), {
    fuzzFactor: 3,
    compareLine: (_lineNumber, line, operation, patchContent) => {
      const same = comparableLine(line) === comparableLine(patchContent);
      if (operation === '-' && !same) invalidDeletion = true;
      return same;
    },
  });
  return !invalidDeletion && tolerant !== false;
}

async function applyUnifiedDiff(dir, diffText) {
  const normalizedDiff = String(diffText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  let patches;
  try {
    patches = parsePatch(normalizedDiff);
  } catch (error) {
    return [{
      path: null,
      applied: false,
      reason: 'El cambio no tiene un formato válido. Revisa el formato e inténtalo de nuevo.',
    }];
  }
  patches = patches.filter((patch) => patch.oldFileName || patch.newFileName);
  const results = [];

  if (!patches.length) {
    return [{
      path: null,
      applied: false,
      reason: 'El cambio no tiene un formato válido. Revisa el formato e inténtalo de nuevo.',
    }];
  }

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];
    const targetPath = patchTargetPath(patch);
    if (!targetPath) {
      results.push({ path: null, applied: false, reason: 'No se pudo determinar el archivo del cambio' });
      continue;
    }

    let abs;
    try {
      abs = safeResolve(dir, targetPath);
    } catch {
      // Un path fuera del proyecto rechaza SOLO este parche;
      // nunca debe tumbar el turno completo del chat.
      results.push({ path: targetPath, applied: false, reason: 'Ruta fuera del proyecto no permitida' });
      continue;
    }
    let original = '';
    let isNewFile = false;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      isNewFile = true; // el diff puede estar creando un archivo nuevo
    }

    // Comprobamos PRIMERO si el archivo actual ya es el resultado de este
    // mismo patch (es decir, el patch inverso calza). Esto es lo que pasa
    // cuando el backend ya aplico este diff automaticamente (autoApply) y
    // el usuario, sin saberlo, vuelve a pulsar "Aplicar" sobre el mismo
    // bloque en el chat: sin esta comprobacion, reintentarlo podia fallar
    // con un mensaje confuso o, peor, insertar contenido duplicado si el
    // patch no tenia lineas de contexto (ej. creacion de archivo nuevo).
    // Se hace ANTES del intento hacia adelante para nunca arriesgar una
    // escritura sobre un archivo que ya esta correcto.
    if (!isNewFile) {
      let already = false;
      try {
        already = reversePatchSafely(original, parsePatch(normalizedDiff)[patchIndex]);
      } catch {}
      if (already) {
        results.push({
          path: targetPath,
          applied: true,
          alreadyApplied: true,
          bytes: original.length,
          reason: 'Este cambio ya estaba aplicado en el archivo actual',
        });
        continue;
      }
    }

    // applyPatch mutates hunk offsets while searching, so every retry gets a
    // fresh parsed patch rather than reusing a partially applied object.
    const exactPatch = parsePatch(normalizedDiff)[patchIndex];
    const retryPatch = parsePatch(normalizedDiff)[patchIndex];
    const patched = applyPatchSafely(original, exactPatch, retryPatch);
    if (patched === false) {
      let alreadyApplied = false;
      try {
        alreadyApplied = reversePatchSafely(original, parsePatch(normalizedDiff)[patchIndex]);
      } catch {}
      results.push({
        path: targetPath,
        applied: false,
        alreadyApplied,
        reason: alreadyApplied
          ? 'Este cambio ya parece estar aplicado en el archivo actual'
          : isNewFile
          ? 'El diff no coincide y el archivo no existe todavia'
          : 'El diff no coincide con el contenido actual. Regenera el diff mencionando el archivo para que la IA lea su versión más reciente.',
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

/**
 * Nombre de rama de tarea estilo Codex (H3): `baro/<slug>-<ts36>`.
 * El slug sale del título de la tarea, sin acentos ni caracteres
 * raros; el sufijo temporal evita colisiones. Puro y testeable.
 */
function taskBranchName(title) {
  const slug = String(title || 'tarea')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'tarea';
  // Contador por proceso: dos ramas creadas en el mismo milisegundo
  // no deben colisionar (el timestamp solo no bastaba).
  taskBranchName._counter = (taskBranchName._counter || 0) + 1;
  return `baro/${slug}-${Date.now().toString(36)}${taskBranchName._counter.toString(36)}`;
}

async function getCurrentBranch(dir) {
  const git = simpleGit(dir);
  const status = await git.status();
  return status.current || null;
}

/**
 * Crea la rama de tarea de este turno (H3) a partir de `baseBranch`.
 * Si el checkout de la base falla (p. ej. cambios sin commitear que
 * chocan), crea la rama desde el HEAD actual en vez de romper el
 * turno: lo importante es no escribir nunca sobre main/master.
 * Devuelve { branch, base }.
 */
async function createTaskBranch(dir, baseBranch, title) {
  const git = simpleGit(dir);
  const base = (baseBranch || 'main').trim() || 'main';
  const branch = taskBranchName(title);
  try { await git.fetch('origin', base); } catch {}
  try { await git.checkout(base); } catch {}
  await git.checkout(['-b', branch]);
  return { branch, base };
}

/**
 * Sube una rama (sin commitear nada nuevo): se usa para publicar
 * la ref de la rama de tarea recién creada y para el push normal
 * de /agent/push. Token solo en memoria, remoto limpio después.
 */
async function pushBranch({ dir, branch, token, owner, repo }) {
  const git = simpleGit(dir);
  const useAuthed = !!(token && owner && repo);
  if (useAuthed) {
    await git.remote(['set-url', 'origin', authedRemote(owner, repo, token)]);
  }
  try {
    await git.push('origin', branch, ['--set-upstream']);
  } finally {
    if (useAuthed) await setCleanRemote(git, owner, repo);
  }
  return { pushed: true, branch };
}

/**
 * Abre un PR en GitHub (H3) con fetch directo a api.github.com,
 * sin dependencias nuevas. Si ya existe un PR abierto para esta
 * rama, lo devuelve en vez de duplicarlo. Sin token NO finge
 * haber creado nada: devuelve { ok:false, code:'no-token' } con
 * el motivo honesto (la rama con los cambios ya existe).
 */
async function createPullRequest({ owner, repo, head, base, title, body, token }) {
  if (!owner || !repo || !head || !base) {
    return { ok: false, code: 'bad-args', error: 'Faltan owner/repo/head/base para crear el PR' };
  }
  if (!token) {
    return {
      ok: false,
      code: 'no-token',
      error: 'No hay token de GitHub configurado. Añade GITHUB_TOKEN en el servidor o conecta tu cuenta para abrir el PR; la rama con los cambios ya existe y puedes abrirlo a mano.',
    };
  }
  const headers = {
    'User-Agent': 'Baro',
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  try {
    const existingResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      { headers }
    );
    if (existingResp.ok) {
      const existing = await existingResp.json();
      if (Array.isArray(existing) && existing.length) {
        return { ok: true, alreadyExists: true, url: existing[0].html_url, number: existing[0].number, title: existing[0].title };
      }
    }
  } catch {
    // Si la comprobación falla, se intenta crear el PR igualmente.
  }
  const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: title || `Baro: cambios en ${head}`, head, base, body: body || '' }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, code: 'github-error', status: resp.status, error: (data && data.message) || `GitHub respondió ${resp.status}` };
  }
  return { ok: true, alreadyExists: false, url: data.html_url, number: data.number, title: data.title };
}

async function commitAndPush({ dir, message, branch, name, email, token, owner, repo }) {
  const git = simpleGit(dir);
  await git.addConfig('user.name', name || 'Baro');
  await git.addConfig('user.email', email || 'baro@users.noreply.github.com');

  const status = await git.status();
  const changed = [...status.modified, ...status.not_added, ...status.created, ...status.deleted];
  if (!changed.length) {
    return { pushed: false, reason: 'No hay cambios para subir', files: [] };
  }

  await git.add(changed);
  await git.commit(message || 'update via Baro');

  // Token SOLO en memoria durante este push: se pone el remoto con
  // credencial, se empuja y en el `finally` vuelve el remoto limpio.
  // Nunca se loguea la URL con token.
  const useAuthed = !!(token && owner && repo);
  if (useAuthed) {
    await git.remote(['set-url', 'origin', authedRemote(owner, repo, token)]);
  }
  try {
    await git.push('origin', branch);
  } finally {
    if (useAuthed) await setCleanRemote(git, owner, repo);
  }

  return { pushed: true, files: changed, branch };
}

/** Diff completo contra HEAD + lista de archivos cambiados (estilo Codex `/diff`). */
async function gitStatusDiff(dir) {
  const git = simpleGit(dir);
  const status = await git.status();
  const files = [...new Set([
    ...status.modified, ...status.not_added, ...status.created,
    ...status.deleted, ...status.renamed.map((r) => (typeof r === 'string' ? r : r.to || r.from)),
    ...status.staged,
  ].filter(Boolean))];
  let diff = '';
  try {
    diff = await git.diff(['HEAD']);
  } catch {
    diff = '';
  }
  // Los archivos nuevos (untracked) no salen en `git diff HEAD`:
  // se listan aparte en `files` para que el frontend los muestre.
  return { files, diff };
}

/**
 * Crea un checkpoint del trabajo actual (estilo Codex): si hay
 * cambios, los guarda con `git stash push -u`. Devuelve
 * { id, label, ref, ts } o null si no había nada que guardar.
 * El ref es el hash del commit del stash (estable aunque entren
 * otros stash después); también se acepta restaurarlo por él.
 */
async function createCheckpoint(dir, label) {
  const git = simpleGit(dir);
  const status = await git.status();
  if (!status.files || !status.files.length) return null;
  const cleanLabel = String(label || `baro-checkpoint-${Date.now()}`).slice(0, 120);
  await git.stash(['push', '-u', '-m', cleanLabel]);
  // Tras el push, el checkpoint es stash@{0}: resolvemos su hash.
  let ref = 'stash@{0}';
  try {
    const hash = await git.revparse(['stash@{0}']);
    if (hash && hash.trim()) ref = hash.trim();
  } catch {}
  return { id: `cp-${Date.now().toString(36)}`, label: cleanLabel, ref, ts: Date.now() };
}

/**
 * Restaura un checkpoint creado con createCheckpoint.
 *  - Antes de tocar nada, si hay cambios actuales se guardan en un
 *    stash de seguridad `baro-pre-undo-*` (nada se pierde).
 *  - Si el ref es un hash de stash: `git stash apply <hash>`.
 *  - Si el ref es `stash@{n}`: apply directo.
 * Devuelve { ok, restored, safetyStash }.
 */
async function restoreCheckpoint(dir, ref) {
  const git = simpleGit(dir);
  const target = String(ref || '').trim();
  if (!target) throw new Error('Checkpoint sin ref');

  const status = await git.status();
  let safetyStash = false;
  if (status.files && status.files.length) {
    await git.stash(['push', '-u', '-m', `baro-pre-undo-${Date.now()}`]);
    safetyStash = true;
  }

  if (/^stash@\{\d+\}$/.test(target)) {
    await git.stash(['apply', target]);
  } else {
    // Hash de un commit de stash: apply por hash mantiene la entrada.
    await git.raw(['stash', 'apply', target]);
  }
  return { ok: true, restored: target, safetyStash };
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
  authedRemote,
  cleanRemote,
  setCleanRemote,
  cloneRepo,
  listFiles,
  readFile,
  writeFile,
  safeResolve,
  applyUnifiedDiff,
  extractDiffBlocks,
  commitAndPush,
  taskBranchName,
  getCurrentBranch,
  createTaskBranch,
  pushBranch,
  createPullRequest,
  diffAgainstHead,
  gitStatusDiff,
  createCheckpoint,
  restoreCheckpoint,
};

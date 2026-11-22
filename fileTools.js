'use strict';
// ═══════════════════════════════════════════════════════
// fileTools.js
// C17 (Lote 2 Claude Code): herramientas nativas de
// archivo — leer, buscar, listar y editar con reemplazo
// exacto — como funciones puras sobre el workspace de la
// sesión. El modelo las usa cuando las necesita, en vez de
// recibir archivos inyectados por heurística que no pidió.
//
// Seguridad: todo pasa por el jail de git.safeResolve
// (nada fuera del workspace, nada de .env ni .git); los
// archivos grandes y los binarios se rechazan con un motivo
// claro, nunca se leen a ciegas. La edición NO escribe
// directamente: buildEditDiff produce un diff unificado
// que el turno procesa por la misma vía que apply_diff
// (auto-revisión, rama de tarea, registro en appliedDiffs).
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createTwoFilesPatch } = require('diff');
const git = require('./gitAgent');

const MAX_FILE_BYTES = 500_000; // leer/editar: archivos mayores se rechazan
const DEFAULT_READ_LINES = 600; // mismo tope que la inyección heurística
const MAX_READ_LINES = 4000; // archivos mencionados con @
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILE_BYTES = 200_000;
const MAX_LIST_RESULTS = 200;
const MAX_LINE_CHARS = 200;

function isBinaryText(text) {
  return String(text).includes('\u0000');
}

/**
 * Lee un archivo del workspace por líneas.
 * Devuelve { path, totalLines, startLine, endLine, content, truncated }.
 * startLine/endLine son 1-based. offset es 0-based (línea desde la que
 * se empieza); limit se limita a [1, 4000].
 */
async function readFileLines(dir, relPath, offset = 0, limit = DEFAULT_READ_LINES) {
  const cleanPath = String(relPath || '').trim();
  if (!cleanPath) throw new Error('Falta la ruta del archivo.');
  const abs = git.safeResolve(dir, cleanPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`No encontré el archivo "${cleanPath}".`);
  }
  if (!stat.isFile()) throw new Error(`"${cleanPath}" no es un archivo.`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`El archivo "${cleanPath}" es demasiado grande para leerlo aquí (${Math.round(stat.size / 1024)} KB, máximo ${Math.round(MAX_FILE_BYTES / 1024)} KB).`);
  }
  const content = await git.readFile(dir, cleanPath);
  if (isBinaryText(content.slice(0, 8192))) {
    throw new Error(`"${cleanPath}" no es un archivo de texto.`);
  }
  const lines = content.split('\n');
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const count = Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(Number(limit) || DEFAULT_READ_LINES)));
  const slice = lines.slice(start, start + count);
  return {
    path: cleanPath,
    totalLines: lines.length,
    startLine: start + 1,
    endLine: start + slice.length,
    content: slice.join('\n'),
    truncated: start + slice.length < lines.length,
  };
}

/**
 * Busca un patrón (regex) en los archivos de texto del workspace.
 * Devuelve { matches: [{ path, line, text }], filesSearched, truncated }.
 * line es 1-based; text se recorta a 200 caracteres.
 */
async function searchFiles(dir, pattern, opts = {}) {
  const raw = String(pattern || '');
  if (!raw.trim()) throw new Error('Falta el patrón de búsqueda.');
  let re;
  try {
    re = new RegExp(raw);
  } catch (e) {
    throw new Error(`Ese patrón de búsqueda no es válido: ${e.message}`);
  }
  const prefix = typeof opts.path === 'string' && opts.path.trim()
    ? opts.path.trim().replace(/^\.\//, '').replace(/\/$/, '')
    : '';
  const maxMatches = Math.min(500, Math.max(1, Math.trunc(Number(opts.maxMatches) || MAX_SEARCH_MATCHES)));
  const allFiles = await git.listFiles(dir);
  const files = prefix ? allFiles.filter((f) => f === prefix || f.startsWith(`${prefix}/`)) : allFiles;
  const matches = [];
  let filesSearched = 0;
  for (const file of files) {
    if (matches.length >= maxMatches) break;
    let abs;
    try {
      abs = git.safeResolve(dir, file);
    } catch {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) continue;
    let content;
    try {
      content = await git.readFile(dir, file);
    } catch {
      continue;
    }
    if (isBinaryText(content.slice(0, 8192))) continue;
    filesSearched += 1;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
      if (re.test(lines[i])) {
        matches.push({ path: file, line: i + 1, text: lines[i].slice(0, MAX_LINE_CHARS) });
      }
    }
  }
  return { matches, filesSearched, truncated: matches.length >= maxMatches };
}

/** Convierte un glob (`*`, `**`, `?`) a RegExp sobre la ruta relativa. */
function globToRegExp(pattern) {
  const raw = String(pattern || '').trim();
  if (!raw) throw new Error('Falta el patrón para listar archivos.');
  let out = '^';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '*') {
      if (raw[i + 1] === '*') {
        // `**/` = cero o más directorios; `**` suelto = cualquier cosa.
        if (raw[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Lista archivos del workspace que coinciden con un glob
 * (`*.js` solo nivel superior, `**\/*.js` en cualquier carpeta).
 * Devuelve { files, total, truncated }.
 */
async function listFilesByGlob(dir, pattern) {
  const re = globToRegExp(pattern);
  const allFiles = await git.listFiles(dir);
  const files = allFiles.filter((f) => re.test(f));
  return {
    files: files.slice(0, MAX_LIST_RESULTS),
    total: files.length,
    truncated: files.length > MAX_LIST_RESULTS,
  };
}

/**
 * Construye el diff unificado de un reemplazo exacto de texto.
 * El texto viejo debe aparecer EXACTAMENTE una vez; si no aparece
 * o aparece varias veces, falla con un motivo claro (nunca adivina).
 * Devuelve el diff (string) listo para la vía de apply_diff.
 */
async function buildEditDiff(dir, relPath, oldText, newText) {
  const cleanPath = String(relPath || '').trim();
  if (!cleanPath) throw new Error('Falta la ruta del archivo.');
  if (typeof oldText !== 'string' || !oldText) {
    throw new Error('Falta el texto a reemplazar.');
  }
  if (typeof newText !== 'string') throw new Error('Falta el texto nuevo.');
  if (oldText === newText) throw new Error('El texto nuevo es igual al viejo: no hay nada que cambiar.');
  const abs = git.safeResolve(dir, cleanPath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`No encontré el archivo "${cleanPath}".`);
  }
  if (!stat.isFile()) throw new Error(`"${cleanPath}" no es un archivo.`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`El archivo "${cleanPath}" es demasiado grande para editarlo aquí (${Math.round(stat.size / 1024)} KB, máximo ${Math.round(MAX_FILE_BYTES / 1024)} KB).`);
  }
  const content = await git.readFile(dir, cleanPath);
  if (isBinaryText(content.slice(0, 8192))) {
    throw new Error(`"${cleanPath}" no es un archivo de texto.`);
  }
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    throw new Error(`No encontré ese texto en "${cleanPath}". Léelo primero para ver el contenido exacto.`);
  }
  if (occurrences > 1) {
    throw new Error(`Ese texto aparece ${occurrences} veces en "${cleanPath}": incluye más contexto para que quede un solo lugar.`);
  }
  const newContent = content.replace(oldText, newText);
  return createTwoFilesPatch(`a/${cleanPath}`, `b/${cleanPath}`, content, newContent);
}

module.exports = {
  MAX_FILE_BYTES,
  DEFAULT_READ_LINES,
  MAX_READ_LINES,
  MAX_SEARCH_MATCHES,
  MAX_LIST_RESULTS,
  readFileLines,
  searchFiles,
  globToRegExp,
  listFilesByGlob,
  buildEditDiff,
};

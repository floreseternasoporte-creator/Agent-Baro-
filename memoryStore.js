/**
 * memoryStore.js — Memoria persistente.
 *
 * Las memorias antiguas indexadas por clientId permanecen en data/memories/.
 * La memoria asociada a Firebase usa un subdirectorio distinto y un nombre
 * derivado del UID autenticado, de modo que no se reasignan archivos legacy.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MEMORIES_ROOT = path.join(__dirname, 'data', 'memories');
const AUTHENTICATED_MEMORIES_ROOT = path.join(MEMORIES_ROOT, 'firebase-users');
const MAX_MEMORY_ITEMS = 200;
const MAX_FIREBASE_UID_LENGTH = 128;

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function sanitizeClientId(raw) {
  const clean = String(raw || '').trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) return null;
  return clean;
}

/** @param {string} clientId */
function memoryFile(clientId) {
  return path.join(MEMORIES_ROOT, `${clientId}.json`);
}

/** @param {string} uid */
function authenticatedMemoryFile(uid) {
  return path.join(
    AUTHENTICATED_MEMORIES_ROOT,
    `${crypto.createHash('sha256').update(uid, 'utf8').digest('hex')}.json`,
  );
}

/**
 * @param {string} file
 * @returns {string[]}
 */
function readMemoryFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} file
 * @param {string[]} items
 * @returns {boolean}
 */
function writeMemoryFile(file, items) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporaryFile = `${file}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(items, null, 2));
    fs.renameSync(temporaryFile, file);
    return true;
  } catch (error) {
    console.error('[devagent] no se pudo guardar memoria persistente:', error.message);
    return false;
  }
}

/**
 * @param {unknown} clientId
 * @returns {string[]}
 */
function loadMemory(clientId) {
  const id = sanitizeClientId(clientId);
  return id ? readMemoryFile(memoryFile(id)) : [];
}

/**
 * @param {unknown} clientId
 * @param {unknown} items
 * @returns {boolean}
 */
function saveMemory(clientId, items) {
  const id = sanitizeClientId(clientId);
  if (!id || !Array.isArray(items)) return false;
  return writeMemoryFile(memoryFile(id), items.filter((item) => typeof item === 'string'));
}

/**
 * Lee solo la memoria del UID validado por Firebase.
 * @param {unknown} uid
 * @returns {string[]}
 */
function loadAuthenticatedMemory(uid) {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > MAX_FIREBASE_UID_LENGTH) return [];
  return readMemoryFile(authenticatedMemoryFile(uid));
}

/**
 * @param {unknown} uid
 * @param {unknown} text
 * @returns {{ saved: boolean, memory: string[] }}
 */
function addAuthenticatedMemory(uid, text) {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > MAX_FIREBASE_UID_LENGTH) {
    return { saved: false, memory: [] };
  }
  const clean = String(text || '').trim();
  const items = loadAuthenticatedMemory(uid);
  if (!clean || items.includes(clean)) return { saved: false, memory: items };
  items.push(clean);
  while (items.length > MAX_MEMORY_ITEMS) items.shift();
  if (!writeMemoryFile(authenticatedMemoryFile(uid), items)) {
    return { saved: false, memory: loadAuthenticatedMemory(uid) };
  }
  return { saved: true, memory: items };
}

/**
 * @param {unknown} uid
 * @param {number} index
 * @returns {{ ok: boolean, memory: string[] }}
 */
function forgetAuthenticatedMemory(uid, index) {
  if (typeof uid !== 'string' || uid.length === 0 || uid.length > MAX_FIREBASE_UID_LENGTH) {
    return { ok: false, memory: [] };
  }
  const items = loadAuthenticatedMemory(uid);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return { ok: false, memory: items };
  items.splice(index, 1);
  if (!writeMemoryFile(authenticatedMemoryFile(uid), items)) {
    return { ok: false, memory: loadAuthenticatedMemory(uid) };
  }
  return { ok: true, memory: items };
}

// API legacy conservada para no mover, borrar ni reasignar sus archivos.
function addMemory(clientId, text) {
  const clean = String(text || '').trim();
  const items = loadMemory(clientId);
  if (!clean || items.includes(clean)) return { saved: false, memory: items };
  items.push(clean);
  while (items.length > MAX_MEMORY_ITEMS) items.shift();
  const saved = saveMemory(clientId, items);
  return { saved, memory: saved ? items : loadMemory(clientId) };
}

function forgetMemory(clientId, index) {
  const items = loadMemory(clientId);
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return { ok: false, memory: items };
  items.splice(index, 1);
  const ok = saveMemory(clientId, items);
  return { ok, memory: ok ? items : loadMemory(clientId) };
}

module.exports = {
  addAuthenticatedMemory,
  addMemory,
  forgetAuthenticatedMemory,
  forgetMemory,
  loadAuthenticatedMemory,
  loadMemory,
  MAX_MEMORY_ITEMS,
  sanitizeClientId,
  saveMemory,
};

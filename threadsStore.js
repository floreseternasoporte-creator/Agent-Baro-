'use strict';
// @ts-check
// threadsStore.js — Historial multi-chat persistente (FASE 3, v10).
//
// Cada usuario (UID de Firebase) tiene sus conversaciones guardadas
// en disco: un JSON por usuario bajo data/threads/<sha256(uid)>.json
// (mismo patrón que la memoria autenticada de memoryStore.js, así
// ningún archivo queda indexado por el UID en claro).
// La lista de chats del frontend ya no inventa previews del DOM:
// muestra conversaciones reales con título, preview y hora reales,
// y cada una se puede abrir, renombrar y borrar.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let THREADS_ROOT = process.env.BARO_THREADS_DIR || path.join(__dirname, 'data', 'threads');

const MAX_THREADS_PER_USER = 50;
const MAX_MESSAGES_PER_THREAD = 200;
const MAX_TITLE_LENGTH = 60;
const DEFAULT_TITLE = 'Nueva conversación';

/** Solo para tests: redirige el almacén a un directorio temporal. */
function setThreadsRoot(dir) {
  THREADS_ROOT = dir;
}

function threadsFile(uid) {
  const hash = crypto.createHash('sha256').update(uid, 'utf8').digest('hex');
  return path.join(THREADS_ROOT, `${hash}.json`);
}

function readThreadsFile(uid) {
  try {
    const parsed = JSON.parse(fs.readFileSync(threadsFile(uid), 'utf8'));
    if (parsed && Array.isArray(parsed.threads)) return parsed;
    return { threads: [] };
  } catch {
    return { threads: [] };
  }
}

function writeThreadsFile(uid, data) {
  try {
    fs.mkdirSync(THREADS_ROOT, { recursive: true });
    const file = threadsFile(uid);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('[devagent] no se pudo guardar las conversaciones:', e.message);
    return false;
  }
}

/** @param {string} uid */
function validUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128;
}

/**
 * Título automático a partir del primer mensaje del usuario.
 * @param {string} text
 */
function titleFromMessage(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return DEFAULT_TITLE;
  return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1).trim()}…` : clean;
}

/**
 * Resumen público de una conversación para la lista.
 * @param {any} thread
 */
function threadSummary(thread) {
  const last = thread.messages[thread.messages.length - 1];
  return {
    id: thread.id,
    title: thread.title,
    preview: last ? String(last.text || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '',
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
  };
}

/**
 * @param {string} uid
 * @returns {any[]}
 */
function listThreads(uid) {
  if (!validUid(uid)) return [];
  const { threads } = readThreadsFile(uid);
  return [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(threadSummary);
}

/**
 * @param {string} uid @param {string} id
 */
function getThread(uid, id) {
  if (!validUid(uid) || typeof id !== 'string' || !id) return null;
  const { threads } = readThreadsFile(uid);
  return threads.find((t) => t.id === id) || null;
}

/**
 * @param {string} uid @param {string} [title]
 */
function createThread(uid, title) {
  if (!validUid(uid)) return null;
  const data = readThreadsFile(uid);
  const now = Date.now();
  const thread = {
    id: crypto.randomUUID(),
    title: String(title || '').trim().slice(0, MAX_TITLE_LENGTH) || DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  data.threads.unshift(thread);
  while (data.threads.length > MAX_THREADS_PER_USER) data.threads.pop();
  writeThreadsFile(uid, data);
  return thread;
}

/**
 * Añade mensajes al final de la conversación. Si el título sigue
 * siendo el genérico y llega el primer mensaje del usuario, el
 * título se pone solo a partir de ese mensaje.
 * @param {string} uid @param {string} id
 * @param {{ role: string, text: string, time?: string }[]} messages
 */
function appendToThread(uid, id, messages) {
  if (!validUid(uid)) return null;
  const data = readThreadsFile(uid);
  const thread = data.threads.find((t) => t.id === id);
  if (!thread) return null;
  const now = Date.now();
  for (const m of messages || []) {
    const text = String(m?.text || '').trim();
    if (!text) continue;
    thread.messages.push({
      role: m.role === 'me' ? 'me' : 'ai',
      text: text.slice(0, 20000),
      time: m.time || new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ts: now,
    });
  }
  while (thread.messages.length > MAX_MESSAGES_PER_THREAD) thread.messages.shift();
  const firstUser = thread.messages.find((m) => m.role === 'me');
  if (thread.title === DEFAULT_TITLE && firstUser) {
    thread.title = titleFromMessage(firstUser.text);
  }
  thread.updatedAt = now;
  writeThreadsFile(uid, data);
  return thread;
}

/**
 * @param {string} uid @param {string} id @param {string} title
 */
function renameThread(uid, id, title) {
  if (!validUid(uid)) return null;
  const clean = String(title || '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!clean) return null;
  const data = readThreadsFile(uid);
  const thread = data.threads.find((t) => t.id === id);
  if (!thread) return null;
  thread.title = clean;
  thread.updatedAt = Date.now();
  writeThreadsFile(uid, data);
  return thread;
}

/**
 * @param {string} uid @param {string} id
 */
function deleteThread(uid, id) {
  if (!validUid(uid)) return false;
  const data = readThreadsFile(uid);
  const before = data.threads.length;
  data.threads = data.threads.filter((t) => t.id !== id);
  if (data.threads.length === before) return false;
  writeThreadsFile(uid, data);
  return true;
}

module.exports = {
  listThreads,
  getThread,
  createThread,
  appendToThread,
  renameThread,
  deleteThread,
  threadSummary,
  setThreadsRoot,
  DEFAULT_TITLE,
};

/**
 * memoryStore.js — Memoria PERSISTENTE del usuario.
 *
 * Antes la "memoria a largo plazo" vivía en workspaces/<sessionId>/memory.json,
 * pero el sessionId es un UUID temporal y los workspaces expiran a las 6 horas:
 * la memoria NO sobrevivía entre sesiones de verdad.
 *
 * Ahora la memoria vive en data/memories/<clientId>.json, indexada por un ID
 * persistente del cliente (generado una vez en el navegador y guardado en
 * localStorage). Sobrevive sesiones nuevas, reinicios del servidor y limpieza
 * de workspaces. Esto es memoria de verdad, no marketing.
 */

const fs = require('fs');
const path = require('path');

const MEMORIES_ROOT = path.join(__dirname, 'data', 'memories');
const MAX_MEMORY_ITEMS = 200;

function sanitizeClientId(raw) {
  const clean = String(raw || '').trim().slice(0, 64);
  // Solo alfanuméricos, guion y guion bajo: imposible path traversal.
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clean)) return null;
  return clean;
}

function memoryFile(clientId) {
  return path.join(MEMORIES_ROOT, `${clientId}.json`);
}

function loadMemory(clientId) {
  const id = sanitizeClientId(clientId);
  if (!id) return [];
  try {
    const raw = fs.readFileSync(memoryFile(id), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function saveMemory(clientId, items) {
  const id = sanitizeClientId(clientId);
  if (!id) return false;
  try {
    fs.mkdirSync(MEMORIES_ROOT, { recursive: true });
    const tmp = memoryFile(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
    fs.renameSync(tmp, memoryFile(id)); // escritura atómica
    return true;
  } catch (e) {
    console.error('[devagent] no se pudo guardar memoria persistente:', e.message);
    return false;
  }
}

function addMemory(clientId, text) {
  const clean = String(text || '').trim();
  if (!clean) return { saved: false, memory: [] };
  const items = loadMemory(clientId);
  if (items.includes(clean)) return { saved: false, memory: items }; // no duplicados
  items.push(clean);
  while (items.length > MAX_MEMORY_ITEMS) items.shift();
  saveMemory(clientId, items);
  return { saved: true, memory: items };
}

function forgetMemory(clientId, index) {
  const items = loadMemory(clientId);
  if (index < 0 || index >= items.length) return { ok: false, memory: items };
  items.splice(index, 1);
  saveMemory(clientId, items);
  return { ok: true, memory: items };
}

module.exports = {
  sanitizeClientId,
  loadMemory,
  saveMemory,
  addMemory,
  forgetMemory,
  MAX_MEMORY_ITEMS,
};

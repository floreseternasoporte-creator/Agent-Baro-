// ═══════════════════════════════════════════════════════
// sessionStore.js
// Guarda en memoria el estado de cada sesion de agente:
// que repo tiene clonado, en que carpeta de disco, con que
// rama, y su historial de acciones. Cada sesion vive en su
// propia carpeta bajo workspaces/<sessionId> para que
// dos personas usando la misma instancia de Railway nunca
// mezclen archivos de proyectos distintos.
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const memoryStore = require('./memoryStore');

const WORKSPACES_ROOT = path.join(__dirname, 'workspaces');
const MAX_MEMORY_ITEMS = 100; // legacy por sesión; el almacén persistente usa su propio tope

/** @type {Map<string, Session>} */
const sessions = new Map();

// Una sesion inactiva por mas de este tiempo se limpia sola,
// para no llenar el disco de Railway de clones viejos.
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas

class Session {
  constructor(id) {
    this.id = id;
    this.dir = path.join(WORKSPACES_ROOT, id);
    this.repoFullName = null;   // "usuario/repo"
    this.repoUrl = null;
    this.branch = 'main';
    this.githubToken = null;    // token del usuario para este repo, si lo dio
    this.connectedAt = Date.now();
    this.lastUsedAt = Date.now();
    this.history = [];          // [{role, content}] — historial de chat para dar contexto a la IA
    this.actionLog = [];        // log de acciones reales ejecutadas (para auditar, como hace Codex)
    this.clientId = null;       // ID persistente del cliente (localStorage) para memoria real
    this.memory = this.loadMemory(); // legacy por sesión; se reemplaza con setClientId()
  }

  // Vincula la sesión a la memoria PERSISTENTE del cliente.
  // Sin esto, la memoria muere con el workspace (6h). Con esto, sobrevive
  // entre sesiones, pestañas y reinicios del servidor.
  setClientId(rawId) {
    const id = memoryStore.sanitizeClientId(rawId);
    if (!id) return false;
    if (this.clientId === id) return true;
    this.clientId = id;
    this.memory = memoryStore.loadMemory(id);
    return true;
  }

  memoryFile() {
    return path.join(this.dir, 'memory.json');
  }

  loadMemory() {
    try {
      const raw = fs.readFileSync(this.memoryFile(), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((m) => typeof m === 'string') : [];
    } catch {
      return [];
    }
  }

  saveMemory() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.memoryFile(), JSON.stringify(this.memory, null, 2));
    } catch (e) {
      console.error('[devagent] no se pudo guardar memory.json:', e.message);
    }
  }

  addMemory(text) {
    // Con cliente vinculado, la memoria es persistente de verdad.
    if (this.clientId) {
      const { saved, memory } = memoryStore.addMemory(this.clientId, text);
      this.memory = memory;
      return saved;
    }
    // Legacy: sin clientId, memoria atada a la sesión (muere con el workspace).
    const clean = String(text || '').trim();
    if (!clean) return false;
    if (this.memory.includes(clean)) return false; // no duplicados
    this.memory.push(clean);
    if (this.memory.length > MAX_MEMORY_ITEMS) this.memory.shift();
    this.saveMemory();
    return true;
  }

  forgetMemory(index) {
    if (this.clientId) {
      const { ok, memory } = memoryStore.forgetMemory(this.clientId, Number(index));
      this.memory = memory;
      return ok;
    }
    if (index < 0 || index >= this.memory.length) return false;
    this.memory.splice(index, 1);
    this.saveMemory();
    return true;
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  addLog(entry) {
    this.actionLog.push({ ts: Date.now(), ...entry });
    // No dejar crecer el log indefinidamente en memoria
    if (this.actionLog.length > 500) this.actionLog.shift();
    return this.actionLog[this.actionLog.length - 1];
  }
}

function createSession() {
  const id = crypto.randomUUID();
  const session = new Session(id);
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const session = sessions.get(id);
  if (session) session.touch();
  return session || null;
}

function deleteSession(id) {
  sessions.delete(id);
}

function listSessions() {
  return [...sessions.values()];
}

// Barrido periodico de sesiones viejas.
function sweepExpired(onExpire) {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastUsedAt > SESSION_TTL_MS) {
      sessions.delete(session.id);
      if (onExpire) onExpire(session);
    }
  }
}

module.exports = {
  WORKSPACES_ROOT,
  createSession,
  getSession,
  deleteSession,
  listSessions,
  sweepExpired,
};

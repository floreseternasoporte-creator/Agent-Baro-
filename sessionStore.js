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
const MAX_OWNER_UID_LENGTH = 128;

/** @type {Map<string, Session>} */
const sessions = new Map();

// Una sesion inactiva por mas de este tiempo se limpia sola,
// para no llenar el disco de Railway de clones viejos.
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 horas

class Session {
  /** @param {string} id @param {string} ownerUid */
  constructor(id, ownerUid) {
    this.id = id;
    Object.defineProperty(this, 'ownerUid', {
      value: ownerUid,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    this.dir = path.join(WORKSPACES_ROOT, id);
    this.repoFullName = null;   // "usuario/repo"
    this.repoUrl = null;
    this.branch = 'main';
    this.githubToken = null;    // token del usuario para este repo, si lo dio
    this.connectedAt = Date.now();
    this.lastUsedAt = Date.now();
    this.history = [];          // [{role, content}] — historial de chat para dar contexto a la IA
    this.actionLog = [];        // log de acciones reales ejecutadas (para auditar, como hace Codex)
    // Memoria duradera de sesión estilo Astra (two-layer memory):
    // decisiones, restricciones, intentos fallidos y evidencia de
    // verificación que sobreviven a la compactación del historial.
    // El agente las escribe con "Nota: <texto>" y se inyectan en
    // cada ronda posterior. No es la memoria a largo plazo del
    // cliente ("Recuerda:"); es el cuaderno de trabajo de ESTA tarea.
    this.notes = [];
    this.checkpoints = [];      // checkpoints git estilo Codex (stash): [{id, label, ref, ts}] — tope 10
    this.memory = memoryStore.loadAuthenticatedMemory(ownerUid);
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
    const { saved, memory } = memoryStore.addAuthenticatedMemory(this.ownerUid, text);
    this.memory = memory;
    return saved;
  }

  forgetMemory(index) {
    const { ok, memory } = memoryStore.forgetAuthenticatedMemory(this.ownerUid, Number(index));
    this.memory = memory;
    return ok;
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

  // Guarda una nota duradera de la sesión. Deduplica y limita a 50.
  addNote(text) {
    const clean = String(text || '').trim().slice(0, 500);
    if (!clean) return false;
    if (this.notes.includes(clean)) return false;
    this.notes.push(clean);
    if (this.notes.length > 50) this.notes.shift();
    return true;
  }

  // Bloque listo para inyectar en el prompt de la siguiente ronda.
  notesBlock() {
    if (!this.notes.length) return '';
    return `## NOTAS DURADERAS DE LA SESIÓN (no las olvides: decisiones, intentos fallidos y evidencia ya verificada)\n${this.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  }
}

/** @param {unknown} ownerUid @returns {Session} */
function createSession(ownerUid) {
  if (typeof ownerUid !== 'string' || ownerUid.length === 0 || ownerUid.length > MAX_OWNER_UID_LENGTH) {
    throw new TypeError('Se requiere un UID autenticado para crear la sesión.');
  }
  const id = crypto.randomUUID();
  const session = new Session(id, ownerUid);
  sessions.set(id, session);
  return session;
}

// Registra un checkpoint git en la sesión (tope 10, el más viejo sale).
Session.prototype.addCheckpoint = function addCheckpoint(checkpoint) {
  this.checkpoints.push(checkpoint);
  if (this.checkpoints.length > 10) this.checkpoints.shift();
  return checkpoint;
};

/** @param {string} id @returns {Session | null} */
function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  // Expiración TAMBIÉN al leer (Baro v6): antes una sesión podía vivir
  // hasta ~1 h extra porque solo la borraba el barrido horario de
  // server.js. Si superó el TTL, se borra y se devuelve null, igual
  // que si nunca hubiera existido. (La limpieza del workspace en
  // disco de estas sesiones la sigue haciendo el barrido cuando la
  // sesión expira por inactividad detectada allí; aquí prima no
  // servir sesiones muertas.)
  if (Date.now() - session.lastUsedAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  session.touch();
  return session;
}

/**
 * Devuelve la sesión y renueva su TTL únicamente si pertenece al UID dado.
 * @param {unknown} id
 * @param {unknown} ownerUid
 * @returns {Session | null}
 */
function getOwnedSession(id, ownerUid) {
  if (typeof id !== 'string' || !id || typeof ownerUid !== 'string' || !ownerUid) return null;
  const session = sessions.get(id);
  if (!session || session.ownerUid !== ownerUid) return null;
  return getSession(id);
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
  SESSION_TTL_MS,
  createSession,
  getSession,
  getOwnedSession,
  deleteSession,
  listSessions,
  sweepExpired,
};

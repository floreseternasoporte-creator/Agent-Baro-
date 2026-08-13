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
const path = require('path');

const WORKSPACES_ROOT = path.join(__dirname, 'workspaces');

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

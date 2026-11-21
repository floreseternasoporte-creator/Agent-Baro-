'use strict';
// @ts-check
// jobsStore.js — Trabajos asíncronos (H2, v10).
//
// Un "trabajo" es un turno de chat que sigue corriendo en el servidor
// aunque el usuario cierre la pestaña o se caiga la conexión: el turno
// ya no muere con el SSE (antes `req.on('close')` lo abortaba).
// Cada trabajo guarda sus eventos (los mismos `plan`/`log`/`delta`/
// `done`/`error` del turno) en disco, así el cliente puede re-enganchar
// y reproducirlos al volver.
//
// Patrón tomado de memoryStore.js: un JSON por trabajo bajo data/jobs/,
// escritura atómica (tmp + rename), sin dependencias nuevas.
// Los suscriptores en vivo solo viven en memoria; al reiniciar el
// servidor, los trabajos que quedaron a medias se marcan como
// fallidos con un mensaje honesto (no se finge que terminaron).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let JOBS_ROOT = process.env.BARO_JOBS_DIR || path.join(__dirname, 'data', 'jobs');

const MAX_EVENTS = 5000;
const MAX_JOBS_PER_OWNER = 100;
// Un trabajo terminado se conserva 7 días para poder volver a verlo;
// el barrido lo borra después (lo corre server.js cada hora).
const JOB_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {Map<string, Set<Function>>} */
const subscribers = new Map();
/** AbortControllers en vivo: solo en memoria, nunca en el JSON. @type {Map<string, AbortController>} */
const controllers = new Map();

/** Solo para tests: redirige el almacén a un directorio temporal. */
function setJobsRoot(dir) {
  JOBS_ROOT = dir;
  jobs.clear();
  subscribers.clear();
  controllers.clear();
}

function jobFile(id) {
  return path.join(JOBS_ROOT, `${id}.json`);
}

function writeJobFile(job) {
  try {
    fs.mkdirSync(JOBS_ROOT, { recursive: true });
    const tmp = `${jobFile(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, jobFile(job.id));
    return true;
  } catch (e) {
    console.error('[devagent] no se pudo guardar el trabajo:', e.message);
    return false;
  }
}

function readJobFile(id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(jobFile(id), 'utf8'));
    if (!parsed || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

let lastCreatedAt = 0;

/** @param {string} ownerUid @param {string} sessionId @param {string} message @param {string} [threadId] */
function createJob(ownerUid, sessionId, message, threadId) {
  // createdAt monótono: dos trabajos en el mismo milisegundo
  // ordenarían de forma inestable en la lista.
  const now = Math.max(Date.now(), lastCreatedAt + 1);
  lastCreatedAt = now;
  const job = {
    id: crypto.randomUUID(),
    ownerUid,
    sessionId: sessionId || null,
    threadId: threadId || null,
    message: String(message || '').slice(0, 8000),
    status: 'queued', // queued | running | done | failed | cancelled
    createdAt: now,
    updatedAt: now,
    events: [],
    result: null,
    error: null,
    cancelRequested: false,
  };
  jobs.set(job.id, job);
  writeJobFile(job);
  // Tope por usuario: si se pasa, borra los terminados más viejos.
  try {
    const mine = listJobs(ownerUid, { limit: MAX_JOBS_PER_OWNER + 20 });
    if (mine.length > MAX_JOBS_PER_OWNER) {
      for (const old of mine.slice(MAX_JOBS_PER_OWNER)) {
        if (old.status === 'done' || old.status === 'failed' || old.status === 'cancelled') {
          try { fs.unlinkSync(jobFile(old.id)); } catch { /* ya no existe */ }
          jobs.delete(old.id);
        }
      }
    }
  } catch { /* el tope es higiene, nunca debe romper la creación */ }
  return job;
}

/** @param {string} id @param {string} [ownerUid] */
function getJob(id, ownerUid) {
  if (typeof id !== 'string' || !id) return null;
  let job = jobs.get(id);
  if (!job) {
    job = readJobFile(id);
    if (job) jobs.set(id, job);
  }
  if (!job) return null;
  if (ownerUid && job.ownerUid !== ownerUid) return null;
  return job;
}

/**
 * Resumen público del trabajo (sin el log entero de eventos).
 * @param {any} job
 */
function jobSummary(job) {
  return {
    id: job.id,
    threadId: job.threadId || null,
    message: job.message,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    result: job.result || null,
  };
}

/**
 * Lista los trabajos del usuario, más recientes primero.
 * @param {string} ownerUid
 * @param {{ status?: string, limit?: number }} [opts]
 */
function listJobs(ownerUid, opts = {}) {
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  const out = [];
  try {
    fs.mkdirSync(JOBS_ROOT, { recursive: true });
    for (const file of fs.readdirSync(JOBS_ROOT)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const id = file.slice(0, -5);
      const job = getJob(id, ownerUid);
      if (!job) continue;
      if (opts.status && job.status !== opts.status) continue;
      out.push(jobSummary(job));
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out.slice(0, limit);
}

/**
 * Añade un evento al trabajo (persistido) y lo reenvía a los
 * suscriptores en vivo. Devuelve false si el trabajo no existe.
 * @param {any} job
 * @param {string} event
 * @param {any} data
 */
function appendEvent(job, event, data) {
  if (!job || !job.id) return false;
  job.events.push({ event, data: data === undefined ? null : data, ts: Date.now() });
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  job.updatedAt = Date.now();
  writeJobFile(job);
  const subs = subscribers.get(job.id);
  if (subs) {
    for (const fn of [...subs]) {
      try { fn(event, data); } catch { /* un suscriptor roto no tumba el turno */ }
    }
  }
  return true;
}

/**
 * @param {any} job
 * @param {string} status
 * @param {{ result?: any, error?: string }} [extra]
 */
function setStatus(job, status, extra = {}) {
  if (!job || !job.id) return null;
  job.status = status;
  job.updatedAt = Date.now();
  if (extra.result !== undefined) job.result = extra.result;
  if (extra.error !== undefined) job.error = extra.error;
  writeJobFile(job);
  const subs = subscribers.get(job.id);
  if (subs) {
    for (const fn of [...subs]) {
      try { fn('__status__', { status, result: job.result, error: job.error }); } catch { /* igual que arriba */ }
    }
  }
  return job;
}

/** @param {string} jobId @param {Function} fn */
function subscribe(jobId, fn) {
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(fn);
  return () => {
    const set = subscribers.get(jobId);
    if (set) {
      set.delete(fn);
      if (!set.size) subscribers.delete(jobId);
    }
  };
}

/**
 * Marca el trabajo como cancelado a petición del usuario. El corredor
 * del turno aborta su AbortController; si aún estaba en cola, ni
 * siquiera arranca.
 * @param {string} id @param {string} ownerUid
 */
function requestCancel(id, ownerUid) {
  const job = getJob(id, ownerUid);
  if (!job) return null;
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job;
  job.cancelRequested = true;
  const controller = controllers.get(job.id);
  if (controller) {
    try { controller.abort(); } catch { /* ya abortado */ }
  }
  if (job.status === 'queued') setStatus(job, 'cancelled');
  else writeJobFile(job);
  return job;
}

/** @param {any} job @param {AbortController} controller */
function attachAbortController(job, controller) {
  if (!job) return;
  controllers.set(job.id, controller);
  if (job.cancelRequested) {
    try { controller.abort(); } catch { /* ya abortado */ }
  }
}

/** @param {any} job */
function detachAbortController(job) {
  if (!job) return;
  controllers.delete(job.id);
}

/**
 * Al arrancar el servidor, los trabajos que quedaron `running` o
 * `queued` no pueden reanudarse (su turno vivía en memoria): se
 * marcan como fallidos con el motivo real, nunca como terminados.
 */
function sweepStaleJobs() {
  try {
    fs.mkdirSync(JOBS_ROOT, { recursive: true });
    for (const file of fs.readdirSync(JOBS_ROOT)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const job = readJobFile(file.slice(0, -5));
      if (!job) continue;
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'failed';
        job.error = 'El servidor se reinició mientras trabajaba en esto.';
        job.updatedAt = Date.now();
        jobs.set(job.id, job);
        writeJobFile(job);
      }
    }
  } catch {
    // Si el disco falla, los trabajos en memoria siguen; nada se rompe.
  }
}

/**
 * Borra los trabajos terminados más viejos que el TTL (lo corre
 * server.js cada hora junto al barrido de sesiones).
 */
function sweepExpiredJobs() {
  const now = Date.now();
  try {
    fs.mkdirSync(JOBS_ROOT, { recursive: true });
    for (const file of fs.readdirSync(JOBS_ROOT)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      const job = readJobFile(file.slice(0, -5));
      if (!job) continue;
      if ((job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')
        && now - job.updatedAt > JOB_TTL_MS) {
        try { fs.unlinkSync(jobFile(job.id)); } catch { /* ya no existe */ }
        jobs.delete(job.id);
      }
    }
  } catch {
    // Igual que arriba: no romper nada por un fallo de disco.
  }
}

function isTerminal(status) {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  jobSummary,
  appendEvent,
  setStatus,
  subscribe,
  requestCancel,
  attachAbortController,
  detachAbortController,
  sweepStaleJobs,
  sweepExpiredJobs,
  isTerminal,
  setJobsRoot,
  MAX_JOBS_PER_OWNER,
};

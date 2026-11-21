'use strict';

// Tests HTTP H2 + FASE 3: POST /api/chat responde 202 y crea el
// trabajo; GET /api/jobs/:id/events reproduce los eventos guardados
// y sigue en vivo; POST /cancel detiene el trabajo; los endpoints
// de /api/threads (listar/crear/renombrar/borrar) funcionan y un
// usuario nunca ve los trabajos ni las conversaciones de otro.
// Servidor HTTP real con tokens Firebase simulados, sin LLM.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const test = require('node:test');
const { createFirebaseAuthMiddleware } = require('../authMiddleware');
const chatRoutes = require('../chatRoutes');
const jobsStore = require('../jobsStore');
const repoRoutes = require('../repoRoutes');
const threadsStore = require('../threadsStore');
const { deleteSession, getOwnedSession } = require('../sessionStore');

const USER_A_TOKEN = 'YQ.Yg.Yw';
const USER_B_TOKEN = 'ZA.ZQ.Zg';

function createTestApp(uidA = 'uid-user-a', uidB = 'uid-user-b') {
  const app = express();
  app.use(express.json());
  app.use('/api', createFirebaseAuthMiddleware(async (token) => {
    if (token === USER_A_TOKEN) return { sub: uidA };
    if (token === USER_B_TOKEN) return { sub: uidB };
    throw new Error('Token inválido para la prueba');
  }));
  app.use('/api', repoRoutes);
  app.use('/api', chatRoutes);
  return app;
}

async function startTestServer(t, uidA, uidB) {
  const server = http.createServer(createTestApp(uidA, uidB));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function apiRequest(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${pathname}`, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

function useTmpStores(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-jobs-http-'));
  const jobsDir = path.join(dir, 'jobs');
  const threadsDir = path.join(dir, 'threads');
  jobsStore.setJobsRoot(jobsDir);
  threadsStore.setThreadsRoot(threadsDir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { jobsDir, threadsDir };
}

async function createSessionFor(t, baseUrl, uid) {
  const res = await apiRequest(baseUrl, '/api/session', {
    token: USER_A_TOKEN,
    method: 'POST',
    body: { uid, ownerUid: uid },
  });
  assert.equal(res.status, 200);
  const { sessionId } = await res.json();
  const session = getOwnedSession(sessionId, uid);
  assert.ok(session);
  t.after(() => {
    deleteSession(sessionId);
    fs.rmSync(session.dir, { recursive: true, force: true });
  });
  return sessionId;
}

async function waitForTerminal(baseUrl, jobId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await apiRequest(baseUrl, '/api/jobs', { token: USER_A_TOKEN });
    const { jobs } = await res.json();
    const job = jobs.find((j) => j.id === jobId);
    if (job && jobsStore.isTerminal(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`el trabajo ${jobId} no llegó a estado terminal en ${timeoutMs}ms`);
}

test('POST /api/chat responde 202 con jobId y el trabajo se puede cancelar', async (t) => {
  const unique = crypto.randomUUID();
  const uidA = `uid-user-a-${unique}`;
  const uidB = `uid-user-b-${unique}`;
  useTmpStores(t);
  const baseUrl = await startTestServer(t, uidA, uidB);
  const sessionId = await createSessionFor(t, baseUrl, uidA);

  const chatRes = await apiRequest(baseUrl, '/api/chat', {
    token: USER_A_TOKEN,
    body: { sessionId, message: 'hola, dime algo' },
  });
  assert.equal(chatRes.status, 202);
  const { jobId } = await chatRes.json();
  assert.ok(jobId);

  // Otro usuario no ve el trabajo ni puede cancelarlo.
  assert.equal((await apiRequest(baseUrl, `/api/jobs/${jobId}/events`, { token: USER_B_TOKEN })).status, 404);
  assert.equal((await apiRequest(baseUrl, `/api/jobs/${jobId}/cancel`, { token: USER_B_TOKEN, body: {} })).status, 404);

  const cancelRes = await apiRequest(baseUrl, `/api/jobs/${jobId}/cancel`, {
    token: USER_A_TOKEN,
    body: {},
  });
  assert.equal(cancelRes.status, 200);
  const final = await waitForTerminal(baseUrl, jobId);
  // `cancelled` si el abort llegó a mitad del turno; `failed` si los
  // proveedores fallaron antes de que llegara la cancelación. Lo que
  // no puede pasar es que el turno siga vivo tras cancelar.
  assert.ok(['cancelled', 'failed'].includes(final.status), `estado final: ${final.status}`);

  // El trabajo aparece en la lista del usuario y no en la del otro.
  const mine = await (await apiRequest(baseUrl, '/api/jobs', { token: USER_A_TOKEN })).json();
  assert.ok(mine.jobs.some((j) => j.id === jobId));
  const theirs = await (await apiRequest(baseUrl, '/api/jobs', { token: USER_B_TOKEN })).json();
  assert.ok(!theirs.jobs.some((j) => j.id === jobId));
});

test('GET /api/jobs/:id/events reproduce los eventos guardados y el estado final', async (t) => {
  const unique = crypto.randomUUID();
  const uidA = `uid-user-a-${unique}`;
  const uidB = `uid-user-b-${unique}`;
  useTmpStores(t);
  const baseUrl = await startTestServer(t, uidA, uidB);

  const job = jobsStore.createJob(uidA, 'sess-prueba', 'pregunta de prueba');
  jobsStore.appendEvent(job, 'log', { type: 'info', title: 'Analizando…' });
  jobsStore.appendEvent(job, 'delta', { delta: 'Hola, ' });
  jobsStore.appendEvent(job, 'delta', { delta: '¿qué tal?' });
  jobsStore.setStatus(job, 'done', { result: { text: 'Hola, ¿qué tal?', diffCount: 0 } });

  const res = await apiRequest(baseUrl, `/api/jobs/${job.id}/events`, { token: USER_A_TOKEN });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const body = await res.text();
  assert.match(body, /event: log\n/);
  assert.match(body, /Analizando/);
  assert.match(body, /event: delta\n/);
  assert.match(body, /¿qué tal\?/);
  assert.match(body, /event: __status__\n/);
  assert.match(body, /"status":"done"/);

  assert.equal((await apiRequest(baseUrl, `/api/jobs/${job.id}/events`, { token: USER_B_TOKEN })).status, 404);
  assert.equal((await apiRequest(baseUrl, '/api/jobs/no-existe/events', { token: USER_A_TOKEN })).status, 404);
});

test('los endpoints de /api/threads crean, listan, renombran y borran por usuario', async (t) => {
  const unique = crypto.randomUUID();
  const uidA = `uid-user-a-${unique}`;
  const uidB = `uid-user-b-${unique}`;
  useTmpStores(t);
  const baseUrl = await startTestServer(t, uidA, uidB);

  const created = await apiRequest(baseUrl, '/api/threads', {
    token: USER_A_TOKEN,
    body: { title: 'Mi proyecto' },
  });
  assert.equal(created.status, 201);
  const { thread } = await created.json();
  assert.equal(thread.title, 'Mi proyecto');

  const listed = await (await apiRequest(baseUrl, '/api/threads', { token: USER_A_TOKEN })).json();
  assert.equal(listed.threads.length, 1);
  assert.equal(listed.threads[0].id, thread.id);
  const listedB = await (await apiRequest(baseUrl, '/api/threads', { token: USER_B_TOKEN })).json();
  assert.equal(listedB.threads.length, 0);

  const renamed = await apiRequest(baseUrl, `/api/threads/${thread.id}`, {
    token: USER_A_TOKEN,
    method: 'PATCH',
    body: { title: 'Renombrada' },
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).thread.title, 'Renombrada');
  assert.equal((await apiRequest(baseUrl, `/api/threads/${thread.id}`, {
    token: USER_B_TOKEN, method: 'PATCH', body: { title: 'Robada' },
  })).status, 404);

  const got = await apiRequest(baseUrl, `/api/threads/${thread.id}`, { token: USER_A_TOKEN });
  assert.equal(got.status, 200);
  assert.equal((await got.json()).thread.title, 'Renombrada');

  const deleted = await apiRequest(baseUrl, `/api/threads/${thread.id}`, {
    token: USER_A_TOKEN,
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200);
  assert.equal((await apiRequest(baseUrl, `/api/threads/${thread.id}`, { token: USER_A_TOKEN })).status, 404);
  assert.equal((await (await apiRequest(baseUrl, '/api/threads', { token: USER_A_TOKEN })).json()).threads.length, 0);
});

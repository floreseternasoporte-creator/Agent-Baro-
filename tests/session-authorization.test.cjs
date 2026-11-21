'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const test = require('node:test');
const { createFirebaseAuthMiddleware } = require('../authMiddleware');
const agentRoutes = require('../agentRoutes');
const chatRoutes = require('../chatRoutes');
const feedbackRoutes = require('../feedbackRoutes');
const memoryStore = require('../memoryStore');
const repoRoutes = require('../repoRoutes');
const { deleteSession, getOwnedSession, listSessions } = require('../sessionStore');
const toolsRoutes = require('../toolsRoutes');

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
  app.use('/api', agentRoutes);
  app.use('/api', feedbackRoutes);
  app.use('/api', toolsRoutes);
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
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

test('el middleware devuelve el motivo concreto del 503 con su código', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api', createFirebaseAuthMiddleware(async () => {
    const err = new Error('El inicio de sesión no está configurado en el servidor.');
    err.statusCode = 503;
    err.code = 'firebase_project_not_configured';
    throw err;
  }));
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const res = await fetch(`http://127.0.0.1:${address.port}/api/ping`, {
    headers: { Authorization: 'Bearer YQ.Yg.Yw' },
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'firebase_project_not_configured');
  assert.match(body.error, /no está configurado/);
});

test('mantiene /api/health público y exige identidad Firebase al resto de la API', async (t) => {
  const baseUrl = await startTestServer(t);
  const sessionCountBefore = listSessions().length;

  const healthResponse = await apiRequest(baseUrl, '/api/health');
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true });

  const protectedResponse = await apiRequest(baseUrl, '/api/session', { method: 'POST' });
  assert.equal(protectedResponse.status, 401);
  assert.equal(listSessions().length, sessionCountBefore);
});

test('el UID del token crea la sesión y usuario B no puede leer ni alterar datos de A', async (t) => {
  const unique = crypto.randomUUID();
  const uidA = `uid-user-a-${unique}`;
  const uidB = `uid-user-b-${unique}`;
  const baseUrl = await startTestServer(t, uidA, uidB);
  const legacyClientId = `legacy_${unique.replace(/-/g, '_')}`;
  const legacyMemoryFile = path.join(__dirname, '..', 'data', 'memories', `${legacyClientId}.json`);
  const createResponse = await apiRequest(baseUrl, '/api/session', {
    token: USER_A_TOKEN,
    method: 'POST',
    body: { uid: 'uid-user-b', ownerUid: 'uid-user-b' },
  });
  assert.equal(createResponse.status, 200);
  const { sessionId } = await createResponse.json();
  const session = getOwnedSession(sessionId, uidA);
  assert.ok(session);
  assert.equal(session.ownerUid, uidA);
  assert.equal(Object.getOwnPropertyDescriptor(session, 'ownerUid').writable, false);

  const authenticatedMemoryFile = path.join(
    __dirname,
    '..',
    'data',
    'memories',
    'firebase-users',
    `${crypto.createHash('sha256').update(uidA).digest('hex')}.json`,
  );
  const workspaceFilesBefore = [];
  let sessionLastUsedAt;
  try {
    memoryStore.saveMemory(legacyClientId, ['memoria legacy intacta']);
    assert.deepEqual(memoryStore.loadMemory(legacyClientId), ['memoria legacy intacta']);
    assert.deepEqual(session.memory, []);

    session.addMemory('dato privado de A');
    fs.mkdirSync(session.dir, { recursive: true });
    fs.writeFileSync(path.join(session.dir, 'sentinel.txt'), 'workspace de A', 'utf8');
    const docsDirectory = path.join(session.dir, 'docs');
    fs.mkdirSync(docsDirectory, { recursive: true });
    fs.writeFileSync(path.join(docsDirectory, 'report.txt'), 'descarga privada', 'utf8');
    workspaceFilesBefore.push(...fs.readdirSync(session.dir).sort());
    const ownDownloadResponse = await apiRequest(
      baseUrl,
      `/api/files/download?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent('docs/report.txt')}`,
      { token: USER_A_TOKEN },
    );
    assert.equal(ownDownloadResponse.status, 200);
    assert.equal(await ownDownloadResponse.text(), 'descarga privada');
    sessionLastUsedAt = session.lastUsedAt;
    const memoryBefore = memoryStore.loadAuthenticatedMemory(uidA);
    assert.deepEqual(memoryBefore, ['dato privado de A']);

    const crossUserRequests = [
      apiRequest(baseUrl, `/api/repo/files?sessionId=${encodeURIComponent(sessionId)}`, { token: USER_B_TOKEN }),
      apiRequest(baseUrl, `/api/agent/memory?sessionId=${encodeURIComponent(sessionId)}`, { token: USER_B_TOKEN }),
      apiRequest(baseUrl, '/api/agent/memory', {
        token: USER_B_TOKEN,
        method: 'POST',
        body: { sessionId, clientId: legacyClientId, text: 'intento de escritura cruzada' },
      }),
      apiRequest(baseUrl, '/api/agent/memory', {
        token: USER_B_TOKEN,
        method: 'DELETE',
        body: { sessionId, clientId: legacyClientId, index: 0 },
      }),
      apiRequest(baseUrl, '/api/agent/init', {
        token: USER_B_TOKEN,
        method: 'POST',
        body: { sessionId },
      }),
      apiRequest(baseUrl, '/api/feedback', {
        token: USER_B_TOKEN,
        method: 'POST',
        body: { sessionId, title: 'Prueba', description: 'No debe vincular sesión ajena' },
      }),
      apiRequest(baseUrl, '/api/chat', {
        token: USER_B_TOKEN,
        method: 'POST',
        body: { sessionId, message: 'no debe iniciar un turno' },
      }),
      apiRequest(baseUrl, '/api/tools/video', {
        token: USER_B_TOKEN,
        method: 'POST',
        body: { sessionId, prompt: 'no debe ejecutar una herramienta' },
      }),
      apiRequest(baseUrl, `/api/files/download?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent('docs/report.txt')}`, { token: USER_B_TOKEN }),
    ];
    const responses = await Promise.all(crossUserRequests);
    assert.deepEqual(responses.map((response) => response.status), Array(responses.length).fill(404));

    assert.equal(session.ownerUid, uidA);
    assert.equal(session.lastUsedAt, sessionLastUsedAt, 'un acceso de otro usuario no renueva ni muta la sesión');
    assert.deepEqual(memoryStore.loadAuthenticatedMemory(uidA), memoryBefore);
    assert.deepEqual(memoryStore.loadMemory(legacyClientId), ['memoria legacy intacta']);
    assert.deepEqual(fs.readdirSync(session.dir).sort(), workspaceFilesBefore);
    assert.equal(fs.readFileSync(path.join(session.dir, 'sentinel.txt'), 'utf8'), 'workspace de A');
    assert.equal(fs.existsSync(path.join(session.dir, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(authenticatedMemoryFile), true, 'la memoria permanece en el espacio UID del propietario');
  } finally {
    deleteSession(sessionId);
    fs.rmSync(session.dir, { recursive: true, force: true });
    fs.rmSync(legacyMemoryFile, { force: true });
    fs.rmSync(authenticatedMemoryFile, { force: true });
  }
});

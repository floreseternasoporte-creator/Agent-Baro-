'use strict';

// Tests FASE 3 (historial multi-chat): las conversaciones persisten
// por usuario en disco, con título automático del primer mensaje,
// preview y hora reales, y se pueden renombrar y borrar. Un usuario
// nunca ve las conversaciones de otro.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const threadsStore = require('../threadsStore');

function freshRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-threads-'));
  threadsStore.setThreadsRoot(dir);
  return dir;
}

test('createThread crea una conversación con título genérico', () => {
  freshRoot();
  const t = threadsStore.createThread('uid-1');
  assert.equal(t.title, 'Nueva conversación');
  assert.equal(t.messages.length, 0);
  assert.ok(t.id.length > 10);
  assert.equal(threadsStore.getThread('uid-1', t.id).id, t.id);
});

test('appendToThread pone el título solo a partir del primer mensaje', () => {
  freshRoot();
  const t = threadsStore.createThread('uid-1');
  threadsStore.appendToThread('uid-1', t.id, [
    { role: 'me', text: 'Hazme un comercial de 15 segundos para mi app de comida' },
    { role: 'ai', text: 'Claro, aquí va…' },
  ]);
  const after = threadsStore.getThread('uid-1', t.id);
  assert.equal(after.title, 'Hazme un comercial de 15 segundos para mi app de comida');
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[0].role, 'me');
});

test('listThreads devuelve preview y hora reales, más recientes primero', () => {
  freshRoot();
  const a = threadsStore.createThread('uid-1');
  threadsStore.appendToThread('uid-1', a.id, [{ role: 'me', text: 'primera' }]);
  const b = threadsStore.createThread('uid-1');
  threadsStore.appendToThread('uid-1', b.id, [{ role: 'me', text: 'segunda conversación' }]);
  const list = threadsStore.listThreads('uid-1');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);
  assert.equal(list[0].preview, 'segunda conversación');
  assert.equal(list[0].messageCount, 1);
  assert.ok(list[0].updatedAt > 0);
});

test('renameThread y deleteThread funcionan y no tocan a otros usuarios', () => {
  freshRoot();
  const t = threadsStore.createThread('uid-1');
  assert.equal(threadsStore.renameThread('uid-2', t.id, 'otro'), null);
  const renamed = threadsStore.renameThread('uid-1', t.id, 'Mi proyecto');
  assert.equal(renamed.title, 'Mi proyecto');
  assert.equal(threadsStore.renameThread('uid-1', t.id, '   '), null);
  assert.equal(threadsStore.deleteThread('uid-2', t.id), false);
  assert.equal(threadsStore.deleteThread('uid-1', t.id), true);
  assert.equal(threadsStore.getThread('uid-1', t.id), null);
  assert.equal(threadsStore.listThreads('uid-1').length, 0);
});

test('las conversaciones de un usuario no se ven desde otro', () => {
  freshRoot();
  threadsStore.createThread('uid-1');
  threadsStore.createThread('uid-2');
  assert.equal(threadsStore.listThreads('uid-1').length, 1);
  assert.equal(threadsStore.listThreads('uid-2').length, 1);
  assert.equal(threadsStore.listThreads('uid-3').length, 0);
});

test('el historial persiste en disco entre lecturas', () => {
  const dir = freshRoot();
  const t = threadsStore.createThread('uid-1');
  threadsStore.appendToThread('uid-1', t.id, [{ role: 'me', text: 'hola' }]);
  // El archivo existe y contiene el mensaje aunque se vuelva a leer.
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.equal(raw.threads[0].messages[0].text, 'hola');
});

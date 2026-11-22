'use strict';

// Tests C1 (Lote 2): subagentes reales con su propio turno.
// El generador de texto es un stub: ningún test toca un LLM.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const subagent = require('../subagent');

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-subagent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'const b = 3;\n', 'utf8');
  return dir;
}

function collectLogs() {
  const logs = [];
  const send = (type, payload) => logs.push({ type, ...payload });
  return { logs, send };
}

test('runSubagent lee con la tool nativa y devuelve el resumen', async (t) => {
  const dir = makeWorkspace(t);
  const { logs, send } = collectLogs();
  const calls = [
    { text: '', toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.js' } }], toolsSupported: true },
    { text: 'Resumen: el archivo define a=1 y b=2.', toolCalls: [], toolsSupported: true },
  ];
  let i = 0;
  const streamToolsFn = async () => calls[i++] || calls[calls.length - 1];
  const res = await subagent.runSubagent({
    session: { dir },
    task: 'Explora src/a.js',
    kind: 'explore',
    send,
    streamToolsFn,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'explore');
  assert.match(res.summary, /a=1/);
  assert.deepEqual(res.filesRead, ['src/a.js']);
  assert.equal(res.rounds, 2);
  assert.ok(logs.some((l) => l.title === 'Explorando esa parte por separado…'));
  assert.ok(logs.some((l) => l.title === 'Ya exploré esa parte'));
});

test('runSubagent degrada a texto cuando el proveedor no soporta tools', async (t) => {
  const dir = makeWorkspace(t);
  const { send } = collectLogs();
  const calls = [
    { text: 'Voy a mirar el archivo.\nLeer archivo: src/b.js', toolCalls: [], toolsSupported: false },
    { text: 'Resumen: b.js define b=3.', toolCalls: [], toolsSupported: false },
  ];
  let i = 0;
  const streamToolsFn = async () => calls[i++] || calls[calls.length - 1];
  const res = await subagent.runSubagent({
    session: { dir },
    task: 'Mira src/b.js',
    kind: 'general',
    send,
    streamToolsFn,
  });
  assert.equal(res.ok, true);
  assert.match(res.summary, /b=3/);
  assert.deepEqual(res.filesRead, ['src/b.js']);
});

test('el subagente NUNCA escribe: edit_file y apply_diff se le niegan', async (t) => {
  const dir = makeWorkspace(t);
  const { send } = collectLogs();
  const seenMessages = [];
  const calls = [
    { text: '', toolCalls: [{ name: 'edit_file', arguments: { path: 'src/a.js', oldText: 'const a = 1;', newText: 'const a = 99;' } }], toolsSupported: true },
    { text: 'Resumen: no pude editar, solo leo.', toolCalls: [], toolsSupported: true },
  ];
  let i = 0;
  const streamToolsFn = async ({ messages }) => {
    seenMessages.push(JSON.stringify(messages));
    return calls[i++] || calls[calls.length - 1];
  };
  const res = await subagent.runSubagent({
    session: { dir },
    task: 'Cambia a por 99',
    kind: 'explore',
    send,
    streamToolsFn,
  });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'), 'const a = 1;\nconst b = 2;\n');
  assert.ok(seenMessages[1].includes('no está disponible en este modo de solo lectura'));
});

test('runSubagent devuelve fallo honesto si se agota el tiempo', async (t) => {
  const dir = makeWorkspace(t);
  const { logs, send } = collectLogs();
  const err = new Error('The operation timed out');
  err.name = 'TimeoutError';
  const streamToolsFn = async () => { throw err; };
  const res = await subagent.runSubagent({
    session: { dir },
    task: 'Explora todo',
    kind: 'review',
    send,
    streamToolsFn,
  });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.match(res.summary, /a tiempo/);
  assert.ok(logs.some((l) => l.title === 'No pude terminar esa parte'));
});

test('si el padre cancela, el subagente propaga el abort', async (t) => {
  const dir = makeWorkspace(t);
  const { send } = collectLogs();
  const controller = new AbortController();
  controller.abort();
  const streamToolsFn = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    subagent.runSubagent({
      session: { dir },
      task: 'Explora todo',
      kind: 'explore',
      signal: controller.signal,
      send,
      streamToolsFn,
    }),
    /aborted/,
  );
});

test('normalizeKind cae a explore con kinds desconocidos', () => {
  assert.equal(subagent.normalizeKind('review'), 'review');
  assert.equal(subagent.normalizeKind('inventado'), 'explore');
  assert.equal(subagent.normalizeKind(undefined), 'explore');
});

test('dispatchSubagentCommand rechaza comandos de escritura', async (t) => {
  const dir = makeWorkspace(t);
  assert.equal(await subagent.dispatchSubagentCommand({ tool: 'edit-file', path: 'src/a.js' }, { dir }, undefined), null);
  assert.equal(await subagent.dispatchSubagentCommand({ tool: 'run', commandLine: 'ls' }, { dir }, undefined), null);
});

'use strict';

// Tests H1 (function calling nativo): el catálogo de tools es válido
// OpenAI-compatible, la traducción tool_call -> comando interno produce
// los mismos objetos que el protocolo de texto, y la acumulación de
// deltas de tool_calls del stream reconstruye los argumentos.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BARO_TOOLS,
  toolCallToCommand,
  accumulateToolCallDeltas,
  finalizeToolCalls,
} = require('../toolsCatalog');
const groq = require('../groqClient');
const pollinations = require('../pollinationsClient');
const ollama = require('../ollamaClient');

test('el catálogo tiene 18 tools con schema OpenAI válido', () => {
  assert.equal(BARO_TOOLS.length, 18);
  const names = new Set();
  for (const tool of BARO_TOOLS) {
    assert.equal(tool.type, 'function');
    const fn = tool.function;
    assert.equal(typeof fn.name, 'string');
    assert.ok(fn.name.length > 0);
    assert.ok(!names.has(fn.name), `tool duplicada: ${fn.name}`);
    names.add(fn.name);
    assert.equal(typeof fn.description, 'string');
    assert.ok(fn.description.length > 10);
    assert.equal(fn.parameters.type, 'object');
    assert.equal(typeof fn.parameters.properties, 'object');
    assert.ok(Array.isArray(fn.parameters.required));
    for (const req of fn.parameters.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(fn.parameters.properties, req), `${fn.name}: required "${req}" sin definir en properties`);
    }
  }
  for (const expected of ['search_web', 'run_command', 'apply_diff', 'create_script', 'use_computer', 'save_memory', 'read_file', 'search_files', 'list_files', 'edit_file']) {
    assert.ok(names.has(expected), `falta la tool ${expected}`);
  }
});

test('toolCallToCommand produce los mismos comandos que el protocolo de texto', () => {
  assert.deepEqual(
    toolCallToCommand({ name: 'search_web', arguments: { query: 'fusión nuclear' } }),
    { kind: 'command', command: { tool: 'search', query: 'fusión nuclear' } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'run_command', arguments: { commandLine: 'python3 scripts/x.py' } }),
    { kind: 'command', command: { tool: 'run', commandLine: 'python3 scripts/x.py' } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'create_script', arguments: { name: 'x.py', brief: 'prueba', code: 'print(2+2)' } }),
    { kind: 'command', command: { tool: 'script', name: 'x.py', brief: 'prueba', code: 'print(2+2)' } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'apply_diff', arguments: { diff: '--- a/x\n+++ b/x' } }),
    { kind: 'diff', diff: '--- a/x\n+++ b/x' }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'generate_video', arguments: { prompt: 'gato', durationSec: 9999 } }),
    { kind: 'command', command: { tool: 'video', prompt: 'gato', durationSec: 600 } }
  );
});

// C17 (Lote 2): las tools de archivo producen los mismos comandos que
// sus líneas de texto, y edit_file devuelve kind 'edit' (nunca un
// comando directo: la edición pasa por la vía de revisión de diffs).
test('toolCallToCommand traduce las tools de archivo (C17)', () => {
  assert.deepEqual(
    toolCallToCommand({ name: 'read_file', arguments: { path: 'src/a.js' } }),
    { kind: 'command', command: { tool: 'read-file', path: 'src/a.js', offset: 0, limit: 600 } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'read_file', arguments: { path: 'src/a.js', offset: 9, limit: 30 } }),
    { kind: 'command', command: { tool: 'read-file', path: 'src/a.js', offset: 9, limit: 30 } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'search_files', arguments: { pattern: 'TODO', path: 'src' } }),
    { kind: 'command', command: { tool: 'search-files', pattern: 'TODO', path: 'src' } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'list_files', arguments: { pattern: '**/*.js' } }),
    { kind: 'command', command: { tool: 'list-files', pattern: '**/*.js' } }
  );
  assert.deepEqual(
    toolCallToCommand({ name: 'edit_file', arguments: { path: 'src/a.js', oldText: 'a = 1;', newText: 'a = 10;' } }),
    { kind: 'edit', path: 'src/a.js', oldText: 'a = 1;', newText: 'a = 10;' }
  );
  assert.equal(toolCallToCommand({ name: 'read_file', arguments: {} }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'search_files', arguments: { pattern: '  ' } }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'edit_file', arguments: { path: 'a.js', oldText: 'x' } }).kind, 'invalid');
});

test('extractToolCommands entiende las líneas de archivo (C17)', () => {
  const { extractToolCommands } = require('../toolCommands');
  assert.deepEqual(
    extractToolCommands('Leer archivo: src/a.js'),
    [{ tool: 'read-file', path: 'src/a.js', offset: 0, limit: 600 }]
  );
  assert.deepEqual(
    extractToolCommands('Leer archivo: src/a.js :: 10-40'),
    [{ tool: 'read-file', path: 'src/a.js', offset: 9, limit: 31 }]
  );
  assert.deepEqual(
    extractToolCommands('Buscar en archivos: TODO :: src'),
    [{ tool: 'search-files', pattern: 'TODO', path: 'src' }]
  );
  assert.deepEqual(
    extractToolCommands('Listar archivos: **/*.js'),
    [{ tool: 'list-files', pattern: '**/*.js' }]
  );
  assert.deepEqual(
    extractToolCommands('Editar archivo: src/a.js :: const a = 1; => const a = 10;'),
    [{ tool: 'edit-file', path: 'src/a.js', oldText: 'const a = 1;', newText: 'const a = 10;' }]
  );
  // Las líneas nuevas no se confunden con las viejas.
  assert.deepEqual(
    extractToolCommands('Buscar: noticias de hoy'),
    [{ tool: 'search', query: 'noticias de hoy' }]
  );
  assert.deepEqual(
    extractToolCommands('Editar imagen: https://x/y.png :: ponle un sombrero'),
    [{ tool: 'image', imageUrl: 'https://x/y.png', instruction: 'ponle un sombrero' }]
  );
});

test('toolCallToCommand rechaza tools desconocidas y argumentos rotos', () => {
  assert.equal(toolCallToCommand({ name: 'borrar_todo', arguments: {} }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'search_web', arguments: {} }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'search_web', arguments: { query: '  ' } }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'create_document', arguments: { kind: 'pdf', title: 'x' } }).kind, 'invalid');
  assert.equal(toolCallToCommand({ name: 'run_command', arguments: null, parseError: 'Unexpected token' }).kind, 'invalid');
});

test('accumulateToolCallDeltas reconstruye llamadas fragmentadas del stream', () => {
  let calls = [];
  calls = accumulateToolCallDeltas(calls, [{ index: 0, id: 'call_1', function: { name: 'run_', arguments: '' } }]);
  calls = accumulateToolCallDeltas(calls, [{ index: 0, function: { name: 'command', arguments: '{"command' } }]);
  calls = accumulateToolCallDeltas(calls, [{ index: 0, function: { arguments: 'Line":"ls"}' } }]);
  calls = accumulateToolCallDeltas(calls, [{ index: 1, id: 'call_2', function: { name: 'search_web', arguments: '{"query":"x"}' } }]);
  const final = finalizeToolCalls(calls);
  assert.equal(final.length, 2);
  assert.equal(final[0].name, 'run_command');
  assert.deepEqual(final[0].arguments, { commandLine: 'ls' });
  assert.equal(final[0].parseError, null);
  assert.equal(final[1].name, 'search_web');
});

test('finalizeToolCalls marca JSON roto sin tumbar el resto', () => {
  const final = finalizeToolCalls([
    { id: 'a', name: 'search_web', arguments: '{"query": oops}' },
    { id: 'b', name: 'search_web', arguments: '{"query":"ok"}' },
  ]);
  assert.equal(final[0].parseError !== null, true);
  assert.equal(final[0].arguments, null);
  assert.deepEqual(final[1].arguments, { query: 'ok' });
});

test('los tres clientes exponen streamChatWithTools con la misma firma', () => {
  for (const client of [groq, pollinations, ollama]) {
    assert.equal(typeof client.streamChatWithTools, 'function');
    assert.equal(typeof client.streamChat, 'function');
    assert.equal(typeof client.checkHealth, 'function');
  }
});

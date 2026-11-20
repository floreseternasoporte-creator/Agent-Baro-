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

test('el catálogo tiene 14 tools con schema OpenAI válido', () => {
  assert.equal(BARO_TOOLS.length, 14);
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
  for (const expected of ['search_web', 'run_command', 'apply_diff', 'create_script', 'use_computer', 'save_memory']) {
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

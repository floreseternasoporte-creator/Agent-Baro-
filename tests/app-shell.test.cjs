'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const APP_SHELL_SOURCE = readFileSync(join(__dirname, '..', 'app-shell.js'), 'utf8');
const EXPECTED_ERROR = 'No se pudo iniciar una conversación. Intenta recargar la app.';

function createButton() {
  const listeners = new Map();
  return {
    tagName: 'BUTTON',
    addEventListener(eventName, callback) {
      listeners.set(eventName, callback);
    },
    click() {
      listeners.get('click')?.();
    },
  };
}

function loadAppShell(button, actions) {
  const errors = [];
  const documentRef = {
    getElementById(id) {
      assert.equal(id, 'new-chat-btn');
      return button;
    },
  };
  const sandbox = {
    document: documentRef,
    window: actions,
    console: { error: (...details) => errors.push(details) },
  };

  vm.runInNewContext(APP_SHELL_SOURCE, sandbox, { filename: 'app-shell.js' });
  return { errors };
}

test('enlaza nueva conversación limpiando y mostrando el chat en ese orden', () => {
  const button = createButton();
  const calls = [];
  const actions = {
    clearChat: () => calls.push('clear'),
    showScreen: (screen) => calls.push(screen),
  };

  loadAppShell(button, actions);
  button.click();

  assert.deepEqual(calls, ['clear', 'chat']);
});

test('si falta el control, registra el problema sin interrumpir el arranque', () => {
  const { errors } = loadAppShell(null, {});

  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /no se pudo iniciar/i);
});

test('si falta una acción global, avisa y no lanza una excepción al pulsar', () => {
  const button = createButton();
  const notices = [];
  const actions = { showToast: (message) => notices.push(message) };
  const { errors } = loadAppShell(button, actions);

  assert.doesNotThrow(() => button.click());
  assert.deepEqual(notices, [EXPECTED_ERROR]);
  assert.equal(errors.length, 1);
});

test('si limpiar el chat falla, notifica el error y no navega como si hubiera funcionado', () => {
  const button = createButton();
  const calls = [];
  const notices = [];
  const actions = {
    clearChat() {
      calls.push('clear');
      throw new Error('storage unavailable');
    },
    showScreen: (screen) => calls.push(screen),
    showToast: (message) => notices.push(message),
  };
  const { errors } = loadAppShell(button, actions);

  assert.doesNotThrow(() => button.click());
  assert.deepEqual(calls, ['clear']);
  assert.deepEqual(notices, [EXPECTED_ERROR]);
  assert.equal(errors.length, 1);
});

test('si mostrar el aviso también falla, el error secundario queda aislado', () => {
  const button = createButton();
  const actions = {
    clearChat() {
      throw new Error('clear failed');
    },
    showScreen() {},
    showToast() {
      throw new Error('toast failed');
    },
  };
  const { errors } = loadAppShell(button, actions);

  assert.doesNotThrow(() => button.click());
  assert.equal(errors.length, 2);
});

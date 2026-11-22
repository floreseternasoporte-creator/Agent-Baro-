'use strict';

// stripProtocolLines vive en script.js (frontend vanilla): se extrae su
// fuente exacta y se evalúa aislada, igual que app-shell.test.cjs carga
// su módulo en una vm. Así el test cubre el código real que pinta las
// burbujas, no una copia.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SCRIPT_SOURCE = readFileSync(join(__dirname, '..', 'script.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `no se encontró function ${name} en script.js`);
  let depth = 0;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`no se encontró el cierre de function ${name}`);
}

const stripProtocolLines = vm.runInNewContext(
  `${extractFunction(SCRIPT_SOURCE, 'stripProtocolLines')}\nstripProtocolLines;`,
  {},
  { filename: 'stripProtocolLines' },
);

test('quita líneas de protocolo al inicio de la respuesta', () => {
  assert.equal(stripProtocolLines('Ejecuta: python3 scripts/x.py\nHola, aquí tienes el resultado'), 'Hola, aquí tienes el resultado');
  assert.equal(stripProtocolLines('Buscar: gatos\nTexto'), 'Texto');
  assert.equal(stripProtocolLines('Wikipedia: París\nTexto'), 'Texto');
  assert.equal(stripProtocolLines('Crear script: hola.py\nTexto'), 'Texto');
  assert.equal(stripProtocolLines('Generar video: un gato, 5s\nTexto'), 'Texto');
  assert.equal(stripProtocolLines('### Ejecuta: algo\nTexto'), 'Texto');
});

test('no toca el texto normal ni ejemplos dentro de bloques de código', () => {
  assert.equal(stripProtocolLines('Voy a buscar información para ti'), 'Voy a buscar información para ti');
  assert.equal(stripProtocolLines('Ejecutar el comando lleva un rato'), 'Ejecutar el comando lleva un rato');
  assert.equal(
    stripProtocolLines('Aquí tienes un ejemplo:\n```\nEjecuta: python3 scripts/x.py\n```\nDespués del ejemplo'),
    'Aquí tienes un ejemplo:\n```\nEjecuta: python3 scripts/x.py\n```\nDespués del ejemplo',
  );
});

test('colapsa los huecos que dejan las líneas quitadas', () => {
  assert.equal(stripProtocolLines('Buscar: gatos\n\n\nTexto'), 'Texto');
  assert.equal(stripProtocolLines(''), '');
});

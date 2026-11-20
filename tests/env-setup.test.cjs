'use strict';

// Tests H6 (entorno reproducible): la detección de setup/tests lee
// manifiestos y respeta la convención ## Setup / ## Testing del
// AGENTS.md del repo, y runEnvSetup ejecuta setup + healthcheck de
// verdad en un repo de prueba (sin red: npm install sin dependencias
// y un test que pasa / otro que falla).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAgentsSetup, detectEnv, runEnvSetup } = require('../envSetup');

test('parseAgentsSetup lee Setup y Testing del AGENTS.md del repo', () => {
  const text = [
    '# AGENTS.md',
    '',
    '## Setup',
    '- Instalar dependencias: `npm ci`',
    '',
    '## Testing',
    '- Ejecutar tests: `npm run test:unit`',
    '',
    '## Reglas',
    '- No romper nada.',
  ].join('\n');
  assert.deepEqual(parseAgentsSetup(text), { setup: 'npm ci', test: 'npm run test:unit' });
  assert.deepEqual(parseAgentsSetup('# AGENTS.md\n\nSin secciones.\n'), { setup: null, test: null });
});

test('detectEnv lee package.json y respeta el override de AGENTS.md', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-env-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo', scripts: { test: 'node --version' },
    }));
    const detected = await detectEnv(dir);
    assert.deepEqual(detected.setupCommands, ['npm install']);
    assert.equal(detected.testCommand, 'npm test');
    assert.deepEqual(detected.languages, ['Node.js']);

    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '## Setup\n\n`npm ci --no-audit`\n\n## Testing\n\n`npm run test:unit`\n');
    const overridden = await detectEnv(dir);
    assert.deepEqual(overridden.setupCommands, ['npm ci --no-audit']);
    assert.equal(overridden.testCommand, 'npm run test:unit');
    assert.equal(overridden.source, 'AGENTS.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('detectEnv detecta Python con requirements y pytest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-env-py-'));
  try {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '# sin dependencias\n');
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n');
    const detected = await detectEnv(dir);
    assert.deepEqual(detected.setupCommands, ['pip install -r requirements.txt']);
    assert.equal(detected.testCommand, 'python3 -m pytest -q');
    assert.deepEqual(detected.languages, ['Python']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeSession(dir) {
  const logs = [];
  return {
    dir,
    envHealth: null,
    addLog: (entry) => { logs.push(entry); return entry; },
    _logs: logs,
  };
}

test('runEnvSetup ejecuta setup + tests de verdad y cachea el resultado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-env-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo', scripts: { test: 'node --version' },
    }));
    const session = fakeSession(dir);
    const health = await runEnvSetup(session, null);
    assert.equal(health.status, 'done');
    assert.equal(health.ok, true);
    assert.equal(health.setup.length, 1);
    assert.equal(health.setup[0].command, 'npm install');
    assert.equal(health.setup[0].ok, true);
    assert.equal(health.test.command, 'npm test');
    assert.equal(health.test.ok, true);
    // Segunda llamada: mismo objeto, sin re-ejecutar.
    const again = await runEnvSetup(session, null);
    assert.equal(again, health);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runEnvSetup reporta tests en rojo con honestidad', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-env-red-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo', scripts: { test: 'exit 1' },
    }));
    const session = fakeSession(dir);
    const health = await runEnvSetup(session, null);
    assert.equal(health.status, 'done');
    assert.equal(health.ok, false);
    assert.equal(health.setup[0].ok, true);
    assert.equal(health.test.ok, false);
    assert.match(health.detail, /tests no pasan|en rojo/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

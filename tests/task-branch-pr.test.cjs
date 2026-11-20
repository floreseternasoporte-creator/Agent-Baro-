'use strict';

// Tests H3 (ramas por tarea + PRs): el nombre de rama se sanitiza,
// createTaskBranch crea la rama real en un repo temporal, y
// createPullRequest es honesto sin token (no finge haber creado
// nada) y construye la llamada correcta a api.github.com con token.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const simpleGit = require('simple-git');
const {
  taskBranchName,
  getCurrentBranch,
  createTaskBranch,
  createPullRequest,
} = require('../gitAgent');

test('taskBranchName sanitiza el título y es único por timestamp', () => {
  const a = taskBranchName('Añadir login con 2FA!!');
  assert.match(a, /^baro\/anadir-login-con-2fa-[0-9a-z]+$/);
  const b = taskBranchName('');
  assert.match(b, /^baro\/tarea-[0-9a-z]+$/);
  const long = taskBranchName('x'.repeat(100));
  assert.ok(long.length < 'baro/'.length + 40 + 1 + 20, 'el slug se trunca a 40 caracteres');
  assert.notEqual(taskBranchName('misma tarea'), taskBranchName('misma tarea'));
});

async function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-branch-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.name', 'Baro Test');
  await git.addConfig('user.email', 'test@baro.local');
  fs.writeFileSync(path.join(dir, 'README.md'), '# repo de prueba\n');
  await git.add('README.md');
  await git.commit('commit inicial');
  return { dir, git };
}

test('createTaskBranch crea la rama real y deja el trabajo en ella', async () => {
  const { dir, git } = await makeTempRepo();
  try {
    const base = await getCurrentBranch(dir);
    assert.ok(base, 'el repo temporal tiene rama actual');
    const created = await createTaskBranch(dir, base, 'Añadir login con 2FA');
    assert.equal(created.base, base);
    assert.match(created.branch, /^baro\/anadir-login-con-2fa-[0-9a-z]+$/);
    assert.equal(await getCurrentBranch(dir), created.branch);
    // El commit inicial sigue estando en la rama nueva.
    const log = await git.log();
    assert.equal(log.total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createPullRequest sin token es honesto y no llama a GitHub', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('no debería llamarse'); };
  try {
    const result = await createPullRequest({
      owner: 'alguien', repo: 'repo', head: 'baro/x-abc', base: 'main',
      title: 't', body: 'b', token: null,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'no-token');
    assert.match(result.error, /token/i);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('createPullRequest crea el PR contra api.github.com con el token', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('/pulls?head=')) {
      return { ok: true, json: async () => [] };
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://github.com/alguien/repo/pull/7', number: 7, title: 'Baro: x' }),
    };
  };
  try {
    const result = await createPullRequest({
      owner: 'alguien', repo: 'repo', head: 'baro/x-abc', base: 'main',
      title: 'Baro: x', body: 'cuerpo', token: 'ghp_secreto',
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, false);
    assert.equal(result.number, 7);
    assert.equal(result.url, 'https://github.com/alguien/repo/pull/7');
    assert.equal(calls.length, 2);
    const post = calls[1];
    assert.match(post.url, /\/repos\/alguien\/repo\/pulls$/);
    assert.equal(post.opts.method, 'POST');
    assert.equal(post.opts.headers.Authorization, 'Bearer ghp_secreto');
    const body = JSON.parse(post.opts.body);
    assert.equal(body.head, 'baro/x-abc');
    assert.equal(body.base, 'main');
    assert.equal(body.title, 'Baro: x');
  } finally {
    global.fetch = originalFetch;
  }
});

test('createPullRequest devuelve el PR existente en vez de duplicarlo', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => [{ html_url: 'https://github.com/alguien/repo/pull/3', number: 3, title: 'viejo' }],
    };
  };
  try {
    const result = await createPullRequest({
      owner: 'alguien', repo: 'repo', head: 'baro/x-abc', base: 'main',
      title: 'Baro: x', body: '', token: 'ghp_secreto',
    });
    assert.equal(result.ok, true);
    assert.equal(result.alreadyExists, true);
    assert.equal(result.number, 3);
    assert.equal(calls.length, 1, 'no debe hacer POST si ya existe el PR');
  } finally {
    global.fetch = originalFetch;
  }
});

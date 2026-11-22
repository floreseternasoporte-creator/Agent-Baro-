'use strict';

// Tests C17 (Lote 2): herramientas nativas de archivo como funciones
// puras sobre un workspace temporal (sin servidor ni modelo).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fileTools = require('../fileTools');

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-filetools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n// TODO: revisar esto\nconsole.log(a + b);\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'b.js'), 'function hola() {\n  return "hola";\n}\nmodule.exports = { hola };\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Proyecto\n\nUn texto cualquiera.\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'TODO: comprar pan\nTODO: llamar a Luis\n', 'utf8');
  return dir;
}

test('readFileLines lee por líneas con offset/limit y marca truncado', async (t) => {
  const dir = makeWorkspace(t);
  const r = await fileTools.readFileLines(dir, 'src/a.js');
  assert.equal(r.path, 'src/a.js');
  assert.equal(r.totalLines, 5);
  assert.equal(r.startLine, 1);
  assert.equal(r.endLine, 5);
  assert.match(r.content, /const a = 1/);
  assert.equal(r.truncated, false);

  const page = await fileTools.readFileLines(dir, 'src/a.js', 2, 1);
  assert.equal(page.startLine, 3);
  assert.equal(page.endLine, 3);
  assert.equal(page.content, '// TODO: revisar esto');
  assert.equal(page.truncated, true);
});

test('readFileLines rechaza rutas fuera del workspace y archivos que no existen', async (t) => {
  const dir = makeWorkspace(t);
  await assert.rejects(fileTools.readFileLines(dir, '../fuera.js'), /fuera del workspace/);
  await assert.rejects(fileTools.readFileLines(dir, 'no-existe.js'), /No encontré/);
  await assert.rejects(fileTools.readFileLines(dir, ''), /Falta la ruta/);
});

test('searchFiles encuentra coincidencias con archivo, línea y texto', async (t) => {
  const dir = makeWorkspace(t);
  const r = await fileTools.searchFiles(dir, 'TODO');
  assert.equal(r.matches.length, 3);
  assert.deepEqual(r.matches.map((m) => `${m.path}:${m.line}`), ['notas.txt:1', 'notas.txt:2', 'src/a.js:3']);
  assert.ok(r.filesSearched >= 4);
  assert.equal(r.truncated, false);
});

test('searchFiles respeta el subdirectorio y rechaza regex inválidos', async (t) => {
  const dir = makeWorkspace(t);
  const r = await fileTools.searchFiles(dir, 'TODO', { path: 'src' });
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, 'src/a.js');
  await assert.rejects(fileTools.searchFiles(dir, '(sin cerrar'), /no es válido/);
  await assert.rejects(fileTools.searchFiles(dir, '   '), /Falta el patrón/);
});

test('listFilesByGlob entiende *, ** y ?', async (t) => {
  const dir = makeWorkspace(t);
  let r = await fileTools.listFilesByGlob(dir, '*.md');
  assert.deepEqual(r.files, ['README.md']);
  r = await fileTools.listFilesByGlob(dir, '**/*.js');
  assert.deepEqual(r.files, ['src/a.js', 'src/deep/b.js']);
  r = await fileTools.listFilesByGlob(dir, 'src/*.js');
  assert.deepEqual(r.files, ['src/a.js']);
  r = await fileTools.listFilesByGlob(dir, 'src/?.js');
  assert.deepEqual(r.files, ['src/a.js']);
  r = await fileTools.listFilesByGlob(dir, '**/*.zzz');
  assert.deepEqual(r.files, []);
  await assert.rejects(fileTools.listFilesByGlob(dir, '   '), /Falta el patrón/);
});

test('buildEditDiff exige texto único y produce un diff aplicable', async (t) => {
  const dir = makeWorkspace(t);
  const diff = await fileTools.buildEditDiff(dir, 'src/a.js', 'const a = 1;', 'const a = 10;');
  assert.match(diff, /^--- a\/src\/a\.js$/m);
  assert.match(diff, /^\+\+\+ b\/src\/a\.js$/m);
  assert.match(diff, /^-const a = 1;$/m);
  assert.match(diff, /^\+const a = 10;$/m);

  await assert.rejects(
    fileTools.buildEditDiff(dir, 'src/a.js', 'no existe este texto', 'x'),
    /No encontré ese texto/,
  );
  await assert.rejects(
    fileTools.buildEditDiff(dir, 'notas.txt', 'TODO', 'HECHO'),
    /aparece 2 veces/,
  );
  await assert.rejects(
    fileTools.buildEditDiff(dir, 'src/a.js', 'const a = 1;', 'const a = 1;'),
    /igual al viejo/,
  );
  await assert.rejects(
    fileTools.buildEditDiff(dir, 'no-existe.js', 'a', 'b'),
    /No encontré/,
  );
});

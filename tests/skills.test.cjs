'use strict';

// Tests C2 (Lote 2): skills — parseo de SKILL.md, carga por carpetas
// con prioridad, invocación "/nombre" y relevancia por mensaje.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const skills = require('../skills');

const SAMPLE = `---
name: revisar
description: Revisión de código: busca errores y problemas de seguridad.
when: revisar código, seguridad
label: revisión de código
defaultTask: Revisa el proyecto.
---

# Revisar código

Pasos de la revisión.
`;

test('parseSkillFile lee frontmatter y cuerpo, y rechaza lo incompleto', () => {
  const s = skills.parseSkillFile(SAMPLE);
  assert.equal(s.name, 'revisar');
  assert.equal(s.label, 'revisión de código');
  assert.equal(s.when, 'revisar código, seguridad');
  assert.equal(s.defaultTask, 'Revisa el proyecto.');
  assert.match(s.body, /Pasos de la revisión/);
  assert.equal(skills.parseSkillFile('sin frontmatter'), null);
  assert.equal(skills.parseSkillFile('---\nname: x\n---\n\ncuerpo'), null); // sin description
  assert.equal(skills.parseSkillFile('---\ndescription: x\n---\n\ncuerpo'), null); // sin name
});

test('loadSkillsFromDir carga SKILL.md de subcarpetas e ignora rotas', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-skills-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'SKILL.md'), SAMPLE, 'utf8');
  fs.mkdirSync(path.join(dir, 'b'));
  fs.writeFileSync(path.join(dir, 'b', 'SKILL.md'), SAMPLE.replace('name: revisar', 'name: verificar'), 'utf8');
  fs.mkdirSync(path.join(dir, 'rota'));
  fs.writeFileSync(path.join(dir, 'rota', 'SKILL.md'), 'sin frontmatter', 'utf8');
  fs.mkdirSync(path.join(dir, 'vacia'));
  const loaded = skills.loadSkillsFromDir(dir);
  assert.deepEqual(loaded.map((s) => s.name).sort(), ['revisar', 'verificar']);
  assert.deepEqual(skills.loadSkillsFromDir(path.join(dir, 'no-existe')), []);
});

test('loadSkills respeta la prioridad: la última carpeta gana', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-skills-prio-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const d1 = path.join(base, 'd1');
  const d2 = path.join(base, 'd2');
  for (const d of [d1, d2]) fs.mkdirSync(path.join(d, 'revisar'), { recursive: true });
  fs.writeFileSync(path.join(d1, 'revisar', 'SKILL.md'), SAMPLE, 'utf8');
  fs.writeFileSync(path.join(d2, 'revisar', 'SKILL.md'), SAMPLE.replace('busca errores', 'busca TODO'), 'utf8');
  const loaded = skills.loadSkills([d1, d2]);
  assert.equal(loaded.length, 1);
  assert.match(loaded[0].description, /TODO/);
});

test('parseSkillInvocation entiende /nombre y es insensible a mayúsculas', () => {
  assert.deepEqual(skills.parseSkillInvocation('/revisar haz esto'), { name: 'revisar', rest: 'haz esto' });
  assert.deepEqual(skills.parseSkillInvocation('/Revisar'), { name: 'revisar', rest: '' });
  assert.deepEqual(skills.parseSkillInvocation('  /verificar los tests  '), { name: 'verificar', rest: 'los tests' });
  assert.equal(skills.parseSkillInvocation('hola /revisar'), null);
  assert.equal(skills.parseSkillInvocation('revisar el código'), null);
  assert.equal(skills.parseSkillInvocation('/'), null);
});

test('matchSkills activa por relevancia y no se dispara con saludos', () => {
  const all = skills.loadSkills([skills.defaultSkillsDir()]);
  assert.deepEqual(all.map((s) => s.name).sort(), ['documentar', 'revisar', 'verificar']);
  assert.deepEqual(
    skills.matchSkills(all, 'revisa el código y busca problemas de seguridad').map((s) => s.name),
    ['revisar'],
  );
  assert.deepEqual(
    skills.matchSkills(all, 'verifica que los tests pasan').map((s) => s.name),
    ['verificar'],
  );
  assert.deepEqual(
    skills.matchSkills(all, 'documenta el proyecto').map((s) => s.name),
    ['documentar'],
  );
  assert.deepEqual(skills.matchSkills(all, 'hola, dime algo'), []);
  assert.deepEqual(skills.matchSkills(all, ''), []);
});

test('skillDescriptions lista nombre y descripción', () => {
  const all = skills.loadSkills([skills.defaultSkillsDir()]);
  const desc = skills.skillDescriptions(all);
  assert.match(desc, /- revisar: Revisión de código/);
  assert.match(desc, /- verificar: Verificar con pruebas reales/);
  assert.match(desc, /- documentar: Documentar el proyecto/);
});

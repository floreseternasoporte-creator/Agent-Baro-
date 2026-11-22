'use strict';
// ═══════════════════════════════════════════════════════
// skills.js
// C2 (Lote 2 Claude Code): skills — archivos SKILL.md con
// descripción, cuándo se activan e instrucciones, cargados
// bajo demanda. Tres fuentes, en orden de prioridad (la
// última gana si dos skills comparten nombre):
//   1. .baro/skills/ del repo (skills integradas),
//   2. ~/.baro/skills/ del usuario (skills personales),
//   3. .baro/skills/ del workspace de la sesión (del proyecto).
// El turno inyecta las descripciones en el prompt siempre y
// el cuerpo completo solo de la skill activa: por invocación
// explícita "/nombre" o por relevancia con el mensaje.
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Parsea un SKILL.md con frontmatter YAML mínimo (name, description, when, label, defaultTask). */
function parseSkillFile(text) {
  const raw = String(text || '');
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const front = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (kv) front[kv[1]] = kv[2];
  }
  const name = (front.name || '').trim();
  const description = (front.description || '').trim();
  if (!name || !description) return null;
  return {
    name,
    description,
    when: (front.when || '').trim(),
    label: (front.label || '').trim() || name,
    defaultTask: (front.defaultTask || '').trim(),
    body: (m[2] || '').trim(),
  };
}

/** Carga las skills de un directorio (una subcarpeta por skill, con SKILL.md dentro). */
function loadSkillsFromDir(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    try {
      const skill = parseSkillFile(text);
      if (skill) out.push(skill);
    } catch {
      continue;
    }
  }
  return out;
}

/** Carga skills de varias carpetas (orden de prioridad: la última gana). */
function loadSkills(dirs) {
  const byName = new Map();
  for (const dir of dirs || []) {
    for (const skill of loadSkillsFromDir(dir)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

function defaultSkillsDir() {
  return path.join(__dirname, '.baro', 'skills');
}

function globalSkillsDir() {
  return path.join(os.homedir(), '.baro', 'skills');
}

function sessionSkillsDir(sessionDir) {
  return path.join(sessionDir, '.baro', 'skills');
}

function findSkill(skills, name) {
  const n = String(name || '').trim().toLowerCase();
  return (skills || []).find((s) => s.name.toLowerCase() === n) || null;
}

/** "/nombre resto" al inicio del mensaje -> { name, rest } o null. */
function parseSkillInvocation(message) {
  const m = String(message || '').match(/^\s*\/([a-z0-9][a-z0-9-]*)\b\s*([\s\S]*)$/i);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: (m[2] || '').trim() };
}

const STOPWORDS = new Set('el la los las de en y que para con por un una unos unas su sus al del lo se es son como más pero si no'.split(' '));

function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-záéíóúñ0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Dos palabras comparten raíz si son iguales o comparten los 4
// primeros caracteres ("revisa" ~ "revisión", "verifica" ~ "verificar").
function sharesStem(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
}

/**
 * Skills relevantes para el mensaje: el nombre cuenta doble y cada
 * palabra compartida con descripción/cuándo suma. Umbral 3, máx. 2.
 */
function matchSkills(skills, message) {
  const msgTokens = tokens(message);
  if (!msgTokens.length) return [];
  const scored = [];
  for (const skill of skills || []) {
    let score = 0;
    if (msgTokens.some((t) => sharesStem(t, skill.name))) score += 2;
    const hayTokens = tokens(`${skill.name} ${skill.description} ${skill.when}`);
    for (const ht of hayTokens) {
      if (msgTokens.some((t) => sharesStem(t, ht))) score += 1;
    }
    if (score >= 3) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.skill);
}

/** Lista corta "- nombre: descripción" para el system prompt. */
function skillDescriptions(skills) {
  return (skills || []).map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

module.exports = {
  parseSkillFile,
  loadSkillsFromDir,
  loadSkills,
  defaultSkillsDir,
  globalSkillsDir,
  sessionSkillsDir,
  findSkill,
  parseSkillInvocation,
  matchSkills,
  skillDescriptions,
};

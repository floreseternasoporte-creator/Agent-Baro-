'use strict';
// ═══════════════════════════════════════════════════════
// subagent.js
// C1 (Lote 2 Claude Code): subagentes reales — workers con
// su propio contexto y su propio turno. El turno principal
// delega una subtarea (explorar, revisar, analizar) y el
// subagente devuelve solo un resumen; NUNCA escribe en el
// repo. Aislamiento por allowlist de solo lectura, no por
// copia del workspace: el subagente solo puede leer archivos,
// buscar en archivos, listar, buscar en internet y consultar
// Wikipedia. Si el modelo intenta cualquier otra cosa, se
// le dice que no está disponible en este modo y sigue.
//
// Límites: 6 rondas y 120 s por subtarea. Si el turno
// principal se cancela, el subagente se aborta también (la
// señal del padre manda); si solo se agota el tiempo, devuelve
// un fallo honesto y el turno principal sigue con lo demás.
//
// El generador de texto se inyecta (streamToolsFn) para no
// crear un require circular con chatRoutes.js.
// ═══════════════════════════════════════════════════════

const { BARO_TOOLS, toolCallToCommand } = require('./toolsCatalog');
const { extractToolCommands } = require('./toolCommands');
const fileTools = require('./fileTools');
const tools = require('./toolsClient');

const SUBAGENT_MAX_ROUNDS = 6;
const SUBAGENT_TIMEOUT_MS = 120_000;
const SUBAGENT_MAX_RESULT_CHARS = 4000;
const SUBAGENT_MAX_TOOL_TEXT_CHARS = 8000;

const SUBAGENT_KINDS = {
  explore: {
    startTitle: 'Explorando esa parte por separado…',
    doneTitle: 'Ya exploré esa parte',
    system: 'Eres un explorador: tu trabajo es entender una parte del proyecto y resumirla. Solo puedes LEER: leer archivos, buscar en archivos, listar archivos, buscar en internet y consultar Wikipedia. NUNCA escribas, edites ni ejecutes nada. Cuando tengas lo que necesitas, devuelve un resumen corto y concreto: qué encontraste, dónde (archivo:línea), y qué falta por mirar. Sin rodeos.',
  },
  review: {
    startTitle: 'Revisando esa parte por separado…',
    doneTitle: 'Ya revisé esa parte',
    system: 'Eres un revisor de código: lee los archivos que te indiquen y devuelve hallazgos priorizados P0 (bloqueante), P1 (importante) y P2 (menor) con archivo:línea y un veredicto final de una línea. Solo puedes LEER: leer archivos, buscar en archivos, listar archivos, buscar en internet y consultar Wikipedia. NUNCA escribas, edites ni ejecutes nada.',
  },
  general: {
    startTitle: 'Analizando esa parte por separado…',
    doneTitle: 'Ya analicé esa parte',
    system: 'Eres un analista: investiga la tarea que te indiquen y devuelve un resumen corto y concreto con tus conclusiones y las fuentes (archivo:línea o enlace). Solo puedes LEER: leer archivos, buscar en archivos, listar archivos, buscar en internet y consultar Wikipedia. NUNCA escribas, edites ni ejecutes nada.',
  },
};

// Tools nativas que el subagente puede usar (solo lectura).
const SUBAGENT_TOOL_NAMES = ['read_file', 'search_files', 'list_files', 'search_web', 'lookup_wikipedia'];
// Comandos internos equivalentes (vía nativa o vía texto).
const SUBAGENT_COMMAND_TOOLS = new Set(['read-file', 'search-files', 'list-files', 'search', 'wikipedia']);

function normalizeKind(kind) {
  return Object.prototype.hasOwnProperty.call(SUBAGENT_KINDS, kind) ? kind : 'explore';
}

function kindTools() {
  return BARO_TOOLS.filter((t) => SUBAGENT_TOOL_NAMES.includes(t.function.name));
}

function capText(text, max = SUBAGENT_MAX_TOOL_TEXT_CHARS) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…(recortado)` : s;
}

/** Ejecuta un comando de solo lectura del subagente; null si no aplica. */
async function dispatchSubagentCommand(command, session, signal) {
  switch (command.tool) {
    case 'read-file': {
      const r = await fileTools.readFileLines(session.dir, command.path, command.offset, command.limit);
      return capText(`### ${r.path} (líneas ${r.startLine}–${r.endLine} de ${r.totalLines})\n\n\`\`\`\n${r.content}\n\`\`\``);
    }
    case 'search-files': {
      const r = await fileTools.searchFiles(session.dir, command.pattern, { path: command.path || '' });
      if (!r.matches.length) return `### Búsqueda en archivos: "${command.pattern}"\nSin coincidencias.`;
      return capText(`### Búsqueda en archivos: "${command.pattern}"\n${r.matches.map((m) => `- ${m.path}:${m.line}: ${m.text}`).join('\n')}`);
    }
    case 'list-files': {
      const r = await fileTools.listFilesByGlob(session.dir, command.pattern);
      return `### Archivos: "${command.pattern}" (${r.total})\n${r.files.map((f) => `- ${f}`).join('\n')}`;
    }
    case 'search': {
      const result = await tools.webSearch({ query: command.query, signal });
      const lines = result.results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n   ${r.snippet}`).join('\n\n');
      return capText(`### Resultado de búsqueda web: "${command.query}"\n${result.answer ? `Respuesta directa: ${result.answer}\n\n` : ''}${lines || 'Sin resultados.'}`);
    }
    case 'wikipedia': {
      const result = await tools.wikipediaLookup({ query: command.query, signal });
      if (!result.found) return `### Wikipedia: "${command.query}"\nNo se encontró ningún artículo relevante.`;
      return capText(`### Wikipedia: ${result.title}\n${result.extract}\n\nFuente: ${result.url}`);
    }
    default:
      return null;
  }
}

/**
 * Corre una subtarea en su propio turno.
 * Devuelve { ok, kind, summary, filesRead, rounds, timedOut? }.
 * Si el padre canceló, LANZA el abort (el turno principal muere
 * con él); si solo se agotó el tiempo, devuelve ok:false.
 */
async function runSubagent({ session, task, kind = 'explore', signal, send, streamToolsFn }) {
  const kindName = normalizeKind(kind);
  const spec = SUBAGENT_KINDS[kindName];
  const toolsList = kindTools();
  const timeoutSignal = AbortSignal.timeout(SUBAGENT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const filesRead = [];
  const messages = [
    { role: 'system', content: spec.system },
    { role: 'user', content: String(task || '') },
  ];
  send?.('log', { type: 'run', title: spec.startTitle });

  let finalText = '';
  let rounds = 0;
  try {
    for (let round = 0; round < SUBAGENT_MAX_ROUNDS; round += 1) {
      rounds = round + 1;
      const { text, toolCalls, toolsSupported } = await streamToolsFn({ messages, tools: toolsList, signal: combined, onDelta: () => {} });
      const dispatched = [];
      if (toolsSupported && Array.isArray(toolCalls) && toolCalls.length) {
        for (const tc of toolCalls) {
          const translated = toolCallToCommand(tc);
          if (translated.kind !== 'command' || !SUBAGENT_COMMAND_TOOLS.has(translated.command.tool)) {
            dispatched.push('(esa acción no está disponible en este modo de solo lectura)');
            continue;
          }
          if (translated.command.tool === 'read-file') filesRead.push(translated.command.path);
          let out;
          try {
            out = await dispatchSubagentCommand(translated.command, session, combined);
          } catch (e) {
            out = `### No se pudo completar esa lectura\n${e.message}`;
          }
          dispatched.push(out || '(sin resultado)');
        }
      } else {
        const commands = extractToolCommands(text || '').filter((c) => SUBAGENT_COMMAND_TOOLS.has(c.tool));
        for (const cmd of commands) {
          if (cmd.tool === 'read-file') filesRead.push(cmd.path);
          let out;
          try {
            out = await dispatchSubagentCommand(cmd, session, combined);
          } catch (e) {
            out = `### No se pudo completar esa lectura\n${e.message}`;
          }
          dispatched.push(out || '(sin resultado)');
        }
      }
      if (dispatched.length) {
        messages.push({ role: 'assistant', content: text || '' });
        messages.push({ role: 'user', content: dispatched.join('\n\n') });
        continue;
      }
      finalText = (text || '').trim();
      break;
    }
  } catch (e) {
    // El padre canceló: el abort se propaga (el turno principal
    // también muere). El timeout propio es un resultado honesto.
    // Cualquier otro fallo (proveedor caído, etc.) también es un
    // resultado honesto, pero con SU motivo, no disfrazado de timeout.
    if (signal && signal.aborted) throw e;
    const isTimeout = combined.aborted || e?.name === 'TimeoutError' || e?.name === 'AbortError';
    console.error('[baro] subagente falló:', e?.name || '', e?.message || e);
    send?.('log', { type: 'err', title: 'No pude terminar esa parte' });
    return {
      ok: false,
      kind: kindName,
      summary: isTimeout
        ? 'No pude terminar esa parte a tiempo.'
        : `No pude completar esa parte: ${e?.message || 'el servicio no respondió'}.`,
      filesRead: [...new Set(filesRead)],
      rounds,
      timedOut: isTimeout,
    };
  }

  const summary = finalText.slice(0, SUBAGENT_MAX_RESULT_CHARS);
  if (!summary) {
    send?.('log', { type: 'err', title: 'No pude terminar esa parte' });
    return { ok: false, kind: kindName, summary: 'No pude completar esa parte.', filesRead: [...new Set(filesRead)], rounds };
  }
  send?.('log', { type: 'ok', title: spec.doneTitle });
  return { ok: true, kind: kindName, summary, filesRead: [...new Set(filesRead)], rounds };
}

module.exports = {
  SUBAGENT_MAX_ROUNDS,
  SUBAGENT_TIMEOUT_MS,
  SUBAGENT_MAX_RESULT_CHARS,
  SUBAGENT_KINDS,
  SUBAGENT_TOOL_NAMES,
  normalizeKind,
  kindTools,
  dispatchSubagentCommand,
  runSubagent,
};

// ═══════════════════════════════════════════════════════
// toolCommands.js
// Igual que commandRunner.extractAutomaticCommands, pero
// para las herramientas "no-código": la IA escribe una
// instrucción en su propia línea y el backend la ejecuta de
// verdad, devolviendo el resultado real al modelo. Mismo
// principio de seguridad: solo se reconoce texto en formato
// exacto, en su propia línea, nada de intérpretes libres.
//
//   Buscar: últimas noticias sobre IA
//   Investigación profunda: el estado de la fusión nuclear en 2026
//   Nota: el usuario prefiere npm sobre yarn (memoria de la sesión)
//   Wikipedia: torre eiffel
//   Generar video: un gato astronauta caminando en la luna, 20s
//   Generar imagen: un castillo flotante al atardecer, estilo anime
//   Editar imagen: <url> :: ponle un sombrero de mago
//   Recuerda: mi nombre es Darel y mi proyecto se llama Atenis
//   Crear documento: Plan de marketing :: para una cafetería, 5 secciones
//   Crear presentación: Mi startup :: 8 diapositivas para inversores
//   Hoja de cálculo: Presupuesto 2026 :: ingresos y gastos mensuales
//   Crear script: calculadora.py :: calculadora con historial (el codigo va
//     en un bloque ```python en la respuesta; luego "Ejecuta: python3
//     scripts/calculadora.py" lo corre de verdad)
//   Usar computadora: busca en google el precio del iPhone 17 y dímelo
//   Revisar código: seguridad y regresiones (revisión READ-ONLY estilo
//     Codex /review; el foco tras los dos puntos es opcional)
//   Leer archivo: src/server.js (o "Leer archivo: src/a.js :: 10-40")
//   Buscar en archivos: TODO (o "Buscar en archivos: TODO :: src")
//   Listar archivos: **/*.js
//   Editar archivo: src/a.js :: const a = 1; => const a = 10;
//     (el texto viejo debe aparecer una sola vez; el cambio pasa
//     por revisión antes de aplicarse, como los diffs)
// ═══════════════════════════════════════════════════════

// "Título :: detalle" -> { title, brief }. El :: es opcional.
function splitDocArgs(raw) {
  const parts = String(raw || '').split(/\s*::\s*/);
  return { title: (parts[0] || '').trim(), brief: parts.slice(1).join(' :: ').trim() };
}

function extractToolCommands(text) {
  const commands = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let match;

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Buscar:\s*(.+?)\s*$/i))) {
      const query = match[1];
      const key = `search\u0000${query}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'search', query }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Nota:\s*(.+?)\s*$/i))) {
      const text = match[1];
      const key = `note\u0000${text}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'session-note', text }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Investigaci[oó]n profunda:\s*(.+?)\s*$/i))) {
      const topic = match[1];
      const key = `deepresearch\u0000${topic}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'deep-research', topic }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Revisar c[oó]digo:\s*(.*?)\s*$/i))) {
      const focus = match[1] || '';
      const key = `codereview\u0000${focus}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'code-review', focus }); }
      continue;
    }

    // C17 (Lote 2): herramientas nativas de archivo. "Leer archivo:
    // <ruta> :: <inicio>-<fin>" lee solo ese rango (líneas 1-based).
    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Leer archivo:\s*(.+?)\s*$/i))) {
      const { title: filePath, brief: range } = splitDocArgs(match[1]);
      let offset = 0;
      let limit = 600;
      const rangeMatch = (range || '').match(/^(\d+)\s*-\s*(\d+)\s*$/);
      if (rangeMatch) {
        const start = Math.max(1, parseInt(rangeMatch[1], 10));
        const end = Math.max(start, parseInt(rangeMatch[2], 10));
        offset = start - 1;
        limit = end - start + 1;
      }
      const key = `readfile\u0000${filePath}\u0000${offset}\u0000${limit}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'read-file', path: filePath, offset, limit }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Buscar en archivos:\s*(.+?)\s*$/i))) {
      const { title: pattern, brief: subdir } = splitDocArgs(match[1]);
      const key = `searchfiles\u0000${pattern}\u0000${subdir}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'search-files', pattern, path: subdir }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Listar archivos:\s*(.+?)\s*$/i))) {
      const pattern = match[1];
      const key = `listfiles\u0000${pattern}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'list-files', pattern }); }
      continue;
    }

    // Editar archivo: <ruta> :: <viejo> => <nuevo>. El texto viejo
    // debe aparecer una sola vez; runToolCommand construye el diff y
    // lo pasa por la vía de revisión de apply_diff (C17).
    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Editar archivo:\s*(.+?)\s*$/i))) {
      const { title: filePath, brief: rest } = splitDocArgs(match[1]);
      const arrow = String(rest || '').split(/\s*=>\s*/);
      const oldText = (arrow[0] || '').trim();
      const newText = arrow.slice(1).join(' => ').trim();
      const key = `editfile\u0000${filePath}\u0000${oldText}\u0000${newText}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'edit-file', path: filePath, oldText, newText }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Wikipedia:\s*(.+?)\s*$/i))) {
      const query = match[1];
      const key = `wikipedia\u0000${query}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'wikipedia', query }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Generar video:\s*(.+?)\s*$/i))) {
      const raw = match[1];
      const durMatch = raw.match(/,?\s*(\d+)\s*s(?:eg(?:undos)?)?\s*$/i);
      const durationSec = durMatch ? parseInt(durMatch[1], 10) : 15;
      const prompt = durMatch ? raw.slice(0, durMatch.index).trim() : raw;
      const key = `video\u0000${prompt}\u0000${durationSec}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'video', prompt, durationSec }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Generar imagen:\s*(.+?)\s*$/i))) {
      const prompt = match[1];
      const key = `imagegen\u0000${prompt}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'image-gen', prompt }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Recuerda:\s*(.+?)\s*$/i))) {
      const text = match[1];
      const key = `memory\u0000${text}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'memory', text }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Crear documento:\s*(.+?)\s*$/i))) {
      const { title, brief } = splitDocArgs(match[1]);
      const key = `docgen\u0000documento\u0000${title}\u0000${brief}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'doc-gen', kind: 'documento', title, brief }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Crear presentaci[oó]n:\s*(.+?)\s*$/i))) {
      const { title, brief } = splitDocArgs(match[1]);
      const key = `docgen\u0000presentacion\u0000${title}\u0000${brief}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'doc-gen', kind: 'presentacion', title, brief }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Hoja de c[aá]lculo:\s*(.+?)\s*$/i))) {
      const { title, brief } = splitDocArgs(match[1]);
      const key = `docgen\u0000hoja\u0000${title}\u0000${brief}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'doc-gen', kind: 'hoja', title, brief }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Editar imagen:\s*(\S+)\s*::\s*(.+?)\s*$/i))) {
      const [, imageUrl, instruction] = match;
      const key = `image\u0000${imageUrl}\u0000${instruction}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'image', imageUrl, instruction }); }
      continue;
    }

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Usar computadora:\s*(.+?)\s*$/i))) {
      const task = match[1];
      const key = `computer\u0000${task}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'computer', task }); }
      continue;
    }

    // Crear script: guarda un archivo de codigo REAL en el workspace
    // de la sesion (scripts/<nombre>) a partir del bloque de codigo
    // cercado que la IA incluye en su respuesta. No necesita repo:
    // es la via para crear y luego ejecutar Python (o JS, etc.) con
    // "Ejecuta:" en el mismo turno, todo visible en tiempo real.
    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Crear script:\s*(.+?)\s*$/i))) {
      const { title, brief } = splitDocArgs(match[1]);
      const key = `script\u0000${title}\u0000${brief}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'script', name: title, brief }); }
      continue;
    }

    // Ejecuta: del USUARIO tambien es determinista (antes solo lo era
    // cuando lo pedia el modelo en sus rondas; si el usuario lo
    // escribia, dependia de que la IA lo repitiera y modelos debiles
    // decian "ejecutado" sin ejecutar nada). Pasa por la MISMA lista
    // blanca de commandRunner que los comandos del modelo.
    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Ejecuta:\s*(.+?)\s*$/i))) {
      const commandLine = match[1];
      const key = `run\u0000${commandLine}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'run', commandLine }); }
      continue;
    }
  }
  return commands;
}

module.exports = { extractToolCommands };

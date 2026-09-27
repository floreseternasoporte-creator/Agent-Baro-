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
  }
  return commands;
}

module.exports = { extractToolCommands };

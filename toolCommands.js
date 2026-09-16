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
//   Wikipedia: torre eiffel
//   Generar video: un gato astronauta caminando en la luna, 20s
//   Generar imagen: un castillo flotante al atardecer, estilo anime
//   Editar imagen: <url> :: ponle un sombrero de mago
//   Recuerda: mi nombre es Darel y mi proyecto se llama Atenis
// ═══════════════════════════════════════════════════════

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

    if ((match = rawLine.match(/^\s*(?:[-*]\s*)?Editar imagen:\s*(\S+)\s*::\s*(.+?)\s*$/i))) {
      const [, imageUrl, instruction] = match;
      const key = `image\u0000${imageUrl}\u0000${instruction}`;
      if (!seen.has(key)) { seen.add(key); commands.push({ tool: 'image', imageUrl, instruction }); }
      continue;
    }
  }
  return commands;
}

module.exports = { extractToolCommands };

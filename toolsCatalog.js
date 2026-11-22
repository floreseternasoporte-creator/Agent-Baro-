// ═══════════════════════════════════════════════════════
// toolsCatalog.js
// Catálogo de herramientas NATIVAS de Baro (function calling
// estilo Codex, H1): definiciones JSON Schema compatibles con
// OpenAI que se pasan a los proveedores en `tools`, y el
// traductor de `tool_calls` del modelo a los comandos internos
// que ya ejecuta runToolCommand (chatRoutes.js).
//
// El protocolo de texto ("Buscar:", "Ejecuta:", ...) SIGUE
// existiendo como respaldo (toolCommands.js): si el proveedor
// no soporta tools, el turno degrada a texto de forma explícita,
// nunca silenciosa. Cada tool nativa produce EXACTAMENTE el
// mismo objeto de comando que su línea de texto, así que la
// deduplicación (seenToolCommands) y el plan-mode funcionan
// igual en ambas vías.
// ═══════════════════════════════════════════════════════

const BARO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Búsqueda web en tiempo real (Tavily). Para datos puntuales: noticias, precios, documentación o un hecho concreto.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Consulta de búsqueda' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_wikipedia',
      description: 'Consulta directa a Wikipedia para datos enciclopédicos rápidos (definiciones, biografías, hechos históricos).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Tema a consultar en Wikipedia' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deep_research',
      description: 'Investigación profunda con varias fuentes reales y citas. Para análisis serios, comparaciones o entender un tema a fondo; no para un solo dato.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Tema a investigar a fondo' },
        },
        required: ['topic'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_code',
      description: 'Revisión de código READ-ONLY estilo Codex /review de los cambios contra HEAD. Devuelve hallazgos P0/P1/P2 con archivo:línea. Nunca aplica cambios.',
      parameters: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'Foco opcional de la revisión (p. ej. "seguridad y regresiones")' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Genera una imagen con IA gratis y sin clave (Pollinations/FLUX).',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Descripción de la imagen a generar' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description: 'Edita, anima o transforma una imagen con IA a partir de su URL y una instrucción en lenguaje natural.',
      parameters: {
        type: 'object',
        properties: {
          imageUrl: { type: 'string', description: 'URL de la imagen a editar' },
          instruction: { type: 'string', description: 'Qué hacer con la imagen' },
        },
        required: ['imageUrl', 'instruction'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description: 'Genera un video con IA (Seedance). Máximo 600 segundos; avisa al usuario del límite de 10 videos por día si está cerca de alcanzarlo.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Descripción del video' },
          durationSec: { type: 'number', description: 'Duración en segundos (por defecto 15, máximo 600)' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Crea un archivo real y descargable: documento Word, presentación PowerPoint u hoja Excel, con contenido redactado por el modelo.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['documento', 'presentacion', 'hoja'], description: 'Tipo de archivo' },
          title: { type: 'string', description: 'Título del documento' },
          brief: { type: 'string', description: 'Detalle opcional: secciones, temas, datos' },
        },
        required: ['kind', 'title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_script',
      description: 'Crea un archivo de código REAL en el workspace (scripts/<nombre>) con el código completo que se pasa en el argumento "code". Después usa run_command para ejecutarlo de verdad en el mismo turno.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nombre del archivo, p. ej. "calculadora.py"' },
          brief: { type: 'string', description: 'Descripción breve de lo que hace el script' },
          code: { type: 'string', description: 'Código fuente COMPLETO del script' },
        },
        required: ['name', 'code'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Ejecuta un comando real en el workspace de la sesión (npm test, pytest, git diff, ls, cat, python3 scripts/x.py...). Pasa por la lista blanca de commandRunner: solo binarios permitidos, sin shell, sin inyección. Devuelve stdout/stderr real.',
      parameters: {
        type: 'object',
        properties: {
          commandLine: { type: 'string', description: 'Comando completo, p. ej. "python3 scripts/calculadora.py"' },
        },
        required: ['commandLine'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_diff',
      description: 'Propone un cambio de código como diff unificado exacto. El servidor lo revisa con un segundo pase del modelo y lo aplica de verdad sobre el archivo real. Nunca reescribas archivos completos: solo diffs quirúrgicos con 3 líneas de contexto arriba y abajo, y un bloque por archivo.',
      parameters: {
        type: 'object',
        properties: {
          diff: { type: 'string', description: 'Diff unificado completo (líneas ---/+++/@@ con contexto exacto)' },
        },
        required: ['diff'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Guarda un dato en la memoria a largo plazo del usuario (nombre, preferencias, decisiones del proyecto). Sobrevive entre sesiones.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Dato a recordar' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_note',
      description: 'Guarda una nota en la memoria duradera de ESTA sesión (decisiones, restricciones, intentos que FALLARON y por qué, evidencia verificada). Es el cuaderno de trabajo de la tarea.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Nota a guardar' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_computer',
      description: 'Abre un navegador Chromium REAL que ve la pantalla y controla de forma autónoma (clic, escritura, scroll, teclas) hasta completar la tarea. Solo para cosas que requieren navegar e interactuar con webs de verdad.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Tarea a completar en el navegador' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Lee un archivo del repo (texto) por líneas. Úsala cuando necesites ver el contenido exacto antes de opinar, revisar o editar.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo en el repo.' },
          offset: { type: 'number', description: 'Línea desde la que empezar (0 = desde el principio). Opcional.' },
          limit: { type: 'number', description: 'Cuántas líneas leer (máximo 4000). Opcional.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Busca un texto (o patrón) en los archivos del repo y devuelve archivo, línea y fragmento de cada coincidencia.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Texto o patrón a buscar.' },
          path: { type: 'string', description: 'Carpeta donde buscar (opcional; por defecto todo el repo).' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Lista los archivos del repo que coinciden con un patrón: "*.js" solo el nivel superior, "**/*.js" en cualquier carpeta, "src/*.js" en esa carpeta.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Patrón de archivos, con * y **.' },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Cambia un trozo exacto de un archivo del repo. El texto viejo debe aparecer una sola vez en el archivo; si aparece varias veces, incluye más contexto. El cambio pasa por revisión antes de aplicarse.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Ruta del archivo en el repo.' },
          oldText: { type: 'string', description: 'El texto exacto a reemplazar.' },
          newText: { type: 'string', description: 'El texto nuevo.' },
        },
        required: ['path', 'oldText', 'newText'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_task',
      description: 'Pide a otro turno que revise una parte por separado y te devuelva un resumen: explorar archivos, revisar código o analizar algo. El otro turno solo lee, nunca escribe en el repo. Úsala cuando una parte necesite atención propia mientras tú sigues con el resto.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'La subtarea a revisar, en lenguaje normal.' },
          kind: { type: 'string', enum: ['explore', 'review', 'general'], description: 'Qué tipo de revisión: explorar, revisar código o analizar. Opcional.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  },
];

// Nombre de tool nativa -> objeto de comando interno (el mismo que
// produce extractToolCommands para la línea de texto equivalente).
const TOOL_TO_COMMAND = {
  search_web: (a) => ({ tool: 'search', query: a.query }),
  lookup_wikipedia: (a) => ({ tool: 'wikipedia', query: a.query }),
  deep_research: (a) => ({ tool: 'deep-research', topic: a.topic }),
  review_code: (a) => ({ tool: 'code-review', focus: a.focus || '' }),
  generate_image: (a) => ({ tool: 'image-gen', prompt: a.prompt }),
  edit_image: (a) => ({ tool: 'image', imageUrl: a.imageUrl, instruction: a.instruction }),
  generate_video: (a) => ({
    tool: 'video',
    prompt: a.prompt,
    durationSec: Math.min(600, Math.max(1, Math.trunc(Number(a.durationSec) || 15))),
  }),
  create_document: (a) => ({ tool: 'doc-gen', kind: a.kind, title: a.title, brief: a.brief || '' }),
  create_script: (a) => ({ tool: 'script', name: a.name, brief: a.brief || '', code: a.code }),
  run_command: (a) => ({ tool: 'run', commandLine: a.commandLine }),
  save_memory: (a) => ({ tool: 'memory', text: a.text }),
  save_note: (a) => ({ tool: 'session-note', text: a.text }),
  use_computer: (a) => ({ tool: 'computer', task: a.task }),
  read_file: (a) => ({
    tool: 'read-file',
    path: a.path,
    offset: Math.max(0, Math.trunc(Number(a.offset) || 0)),
    limit: Math.min(4000, Math.max(1, Math.trunc(Number(a.limit) || 600))),
  }),
  search_files: (a) => ({ tool: 'search-files', pattern: a.pattern, path: a.path || '' }),
  list_files: (a) => ({ tool: 'list-files', pattern: a.pattern }),
  delegate_task: (a) => ({ tool: 'delegate', task: a.task, kind: a.kind || 'explore' }),
};

// Campos obligatorios por tool (además del schema, que el proveedor
// valida; esto es la segunda barrera del lado servidor).
const REQUIRED_ARGS = {
  search_web: ['query'],
  lookup_wikipedia: ['query'],
  deep_research: ['topic'],
  generate_image: ['prompt'],
  edit_image: ['imageUrl', 'instruction'],
  generate_video: ['prompt'],
  create_document: ['kind', 'title'],
  create_script: ['name', 'code'],
  run_command: ['commandLine'],
  apply_diff: ['diff'],
  read_file: ['path'],
  search_files: ['pattern'],
  list_files: ['pattern'],
  edit_file: ['path', 'oldText', 'newText'],
  delegate_task: ['task'],
  save_memory: ['text'],
  save_note: ['text'],
  use_computer: ['task'],
};

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Traduce un tool_call del proveedor a lo que el turno sabe ejecutar.
 * Devuelve:
 *   { kind: 'command', command }  -> runToolCommand (mismo objeto que el texto)
 *   { kind: 'diff', diff }        -> pipeline de diffs (auto-review + apply)
 *   { kind: 'invalid', name, error } -> argumentos rotos o tool desconocida
 */
function toolCallToCommand(toolCall) {
  const name = toolCall?.name;
  if (!name || typeof name !== 'string') {
    return { kind: 'invalid', name: String(name || ''), error: 'tool_call sin nombre' };
  }
  if (toolCall.parseError) {
    return { kind: 'invalid', name, error: `Argumentos JSON inválidos: ${toolCall.parseError}` };
  }
  const args = toolCall.arguments || {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { kind: 'invalid', name, error: 'Los argumentos deben ser un objeto JSON' };
  }
  const required = REQUIRED_ARGS[name];
  if (!required && name !== 'review_code') {
    return { kind: 'invalid', name, error: `Herramienta desconocida: ${name}` };
  }
  for (const field of required || []) {
    const value = args[field];
    if (field === 'kind') {
      if (!['documento', 'presentacion', 'hoja'].includes(value)) {
        return { kind: 'invalid', name, error: `kind inválido: ${String(value)} (documento|presentacion|hoja)` };
      }
      continue;
    }
    if (!nonEmptyString(value)) {
      return { kind: 'invalid', name, error: `Falta el argumento obligatorio "${field}"` };
    }
  }
  if (name === 'delegate_task' && args.kind !== undefined && !['explore', 'review', 'general'].includes(args.kind)) {
    return { kind: 'invalid', name, error: `kind inválido: ${String(args.kind)} (explore|review|general)` };
  }
  if (name === 'apply_diff') return { kind: 'diff', diff: String(args.diff) };
  if (name === 'edit_file') {
    // La edición no escribe directo: produce un diff que el turno
    // revisa y aplica por la misma vía que apply_diff (C17).
    return {
      kind: 'edit',
      path: String(args.path).trim(),
      oldText: String(args.oldText),
      newText: String(args.newText),
    };
  }
  return { kind: 'command', command: TOOL_TO_COMMAND[name](args) };
}

/**
 * Acumula los deltas de tool_calls de un stream OpenAI-compat:
 * cada delta trae {index, id?, function:{name?, arguments?}} con
 * fragmentos que se concatenan por índice. Puro y testeable.
 */
function accumulateToolCallDeltas(calls, deltaToolCalls) {
  const list = Array.isArray(calls) ? calls : [];
  for (const tc of deltaToolCalls || []) {
    const idx = typeof tc.index === 'number' ? tc.index : list.length;
    if (!list[idx]) list[idx] = { id: '', name: '', arguments: '' };
    if (tc.id) list[idx].id = tc.id;
    if (tc.function && typeof tc.function.name === 'string') list[idx].name += tc.function.name;
    if (tc.function && typeof tc.function.arguments === 'string') list[idx].arguments += tc.function.arguments;
  }
  return list;
}

/** Cierra los tool_calls acumulados: parsea los argumentos JSON. */
function finalizeToolCalls(calls) {
  return (calls || [])
    .filter((c) => c && (c.name || c.arguments))
    .map((c) => {
      const raw = String(c.arguments || '').trim();
      let parsed = null;
      let parseError = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          parseError = e.message;
        }
      }
      return { id: c.id || null, name: c.name, arguments: parsed, argumentsRaw: raw, parseError };
    });
}

module.exports = {
  BARO_TOOLS,
  TOOL_TO_COMMAND,
  REQUIRED_ARGS,
  toolCallToCommand,
  accumulateToolCallDeltas,
  finalizeToolCalls,
};

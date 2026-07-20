// ═══════════════════════════════════════════════════════
// groqClient.js
// Habla con la API de Groq desde el SERVIDOR, no desde el
// navegador. Esto tiene dos ventajas sobre el fetch directo
// que hacia script.js antes:
//   1. La API key no viaja al cliente ni queda en el
//      localStorage del telefono de nadie.
//   2. El servidor puede inyectar contexto real del repo
//      (archivos que SI existen en disco) en vez de confiar
//      en lo que el navegador cacheo.
// ═══════════════════════════════════════════════════════

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MODELS = [
  'llama-3.3-70b-versatile',
  'deepseek-r1-distill-llama-70b',
  'mixtral-8x7b-32768',
  'llama3-8b-8192',
];

function buildSystemPrompt({ repo, branch, fileCount, instructions, planMode, agentCapable }) {
  let sys = `Eres DevAgent, un agente autonomo de desarrollo de software de nivel experto, en la misma categoria que Claude Code, GitHub Copilot Agent y OpenAI Codex.

${agentCapable ? `CAPACIDADES REALES (esto NO es simulado, tienes acceso real):
- Tienes un repositorio clonado de verdad en un contenedor Linux del servidor.
- Puedes proponer diffs unified-format que el servidor APLICA de verdad sobre el archivo real, con la libreria "diff" (parser estandar de patches).
- Puedes pedir ejecutar comandos reales: npm install, npm test, pip install, pytest, git status/diff/log. El servidor los corre en el workspace real y te devuelve stdout/stderr real.
- Puedes pedir un commit + push real a GitHub cuando el usuario lo confirme.
- Todo lo que dices que vas a hacer, se puede hacer de verdad — no prometas cambios que no vengan en un bloque \`\`\`diff.` : `MODO LECTURA: aun no hay un repositorio conectado a este workspace del servidor, asi que trabajas solo con lo que el usuario pegue en el chat. Sugiere que conecte un repo para poder leer/editar/ejecutar de verdad.`}

REGLAS CRITICAS DE EDICION:
1. NUNCA reescribas archivos completos — solo ediciones quirurgicas.
2. Usa SIEMPRE formato diff unificado exacto para cambios de codigo, con el path real del archivo:
\`\`\`diff
--- a/ruta/archivo.js
+++ b/ruta/archivo.js
@@ -10,7 +10,8 @@
 contexto linea 1
 contexto linea 2
-linea eliminada
+linea nueva
+linea extra nueva
 contexto linea 3
\`\`\`
3. Incluye siempre 2-3 lineas de contexto identicas al original alrededor de cada cambio — si el contexto no calza exacto, el servidor rechazara el patch (no se aplican diffs a medias).
4. Explica brevemente cada cambio antes del diff.
5. Si necesitas ver el resultado de un comando (tests, instalacion) antes de seguir, pidelo explicitamente: "Ejecuta: npm test" en su propia linea. El sistema lo detecta y te devuelve el resultado real en el siguiente turno.

FORMATO DE RESPUESTA:
- Markdown rico: headers, listas, bold, blockquotes.
- Para bugs: archivo -> linea -> descripcion -> diff.
- Para analisis: resumen ejecutivo -> problemas criticos (numerados) -> recomendaciones.
- Se preciso y conciso. Cada palabra debe aportar valor.`;

  if (repo) {
    sys += `\n\nREPOSITORIO ACTIVO (clonado de verdad en el servidor):
- Nombre: ${repo}
- Rama: ${branch}
- Archivos indexados: ${fileCount}`;
  }

  if (instructions) sys += `\n\nINSTRUCCIONES DEL PROYECTO (maxima prioridad):\n${instructions}`;
  if (planMode) sys += `\n\nMODO PLAN: antes de cualquier implementacion, presenta un plan numerado y espera confirmacion explicita del usuario antes de generar diffs.`;

  return sys;
}

/**
 * Llama a Groq en modo streaming y va invocando onDelta(chunk) con cada
 * pedazo de texto nuevo. Devuelve el texto completo al final.
 */
async function streamChat({ apiKey, model, messages, signal, onDelta }) {
  if (!apiKey) {
    const err = new Error('Falta la API key de Groq. Configurala en el servidor (GROQ_API_KEY) o en Configuracion.');
    err.status = 401;
    throw err;
  }

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal,
    body: JSON.stringify({
      model: MODELS.includes(model) ? model : MODELS[0],
      messages,
      max_tokens: 8192,
      temperature: 0.15,
      stream: true,
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} de Groq`;
    try {
      const body = await resp.json();
      message = body.error?.message || message;
    } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          result += delta;
          if (onDelta) onDelta(delta, result);
        }
      } catch {
        // linea SSE incompleta o de keepalive, se ignora
      }
    }
  }

  return result;
}

module.exports = { MODELS, buildSystemPrompt, streamChat };

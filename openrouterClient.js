// ═══════════════════════════════════════════════════════
// openrouterClient.js
// API gratuita con modelos open source (Llama, Mistral,
// Gemma, Qwen…). Sin instalar nada. Sin costo.
// Interfaz idéntica a ollamaClient para ser drop-in.
// ═══════════════════════════════════════════════════════

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Modelos gratuitos verificados — se intentan en orden hasta que uno responda
const FREE_MODELS = [
  'poolside/laguna-m.1:free',       // coding agent flagship
  'cohere/north-mini-code:free',    // coding agent de Cohere
  'openai/gpt-oss-20b:free',        // OSS de OpenAI 20B
  'nvidia/nemotron-3-super-120b-a12b:free', // 120B NVIDIA
  'openrouter/free',                // fallback genérico de OpenRouter
];

const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || FREE_MODELS[0];

function buildSystemPrompt({ repo, branch, fileCount, instructions, planMode, agentCapable }) {
  let sys = `Eres DevAgent, un agente autonomo de ingenieria de software de nivel senior. Piensas con claridad, actuas de forma precisa y produces codigo de produccion real — no ejemplos ni placeholders.

${agentCapable ? `## ENTORNO REAL (no simulado)
Tienes acceso completo a un repositorio clonado en disco en un servidor Linux:
- **Leer archivos**: el servidor ya los leyo y te los inyecto en el contexto.
- **Editar archivos**: propone diffs unified-format → el servidor los aplica de verdad con patch(1).
- **Ejecutar comandos**: escribe "Ejecuta: <comando>" en su propia linea → el sistema lo corre y te devuelve stdout/stderr real. Usa esto para: npm test, pytest, npm install, git diff, git log.
- **Push a GitHub**: el usuario confirma → el servidor hace commit + push real a la rama conectada.
- **Menciones @archivo**: si el usuario escribe @archivo.ts en su mensaje, el servidor leera ese archivo y te lo pasara en el proximo turno.` : `## MODO SIN REPO
No hay repositorio conectado aun. Trabaja con el codigo que el usuario pegue directamente en el chat. Cuando conecte un repo, tendras acceso completo al codigo real.`}

## REGLAS DE EDICION (OBLIGATORIAS)
1. **Nunca reescribas archivos completos** — solo diffs quirurgicos con los cambios minimos necesarios.
2. **Formato diff unificado exacto** — el contexto debe coincidir byte a byte con el archivo real:
\`\`\`diff
--- a/ruta/exacta/archivo.ts
+++ b/ruta/exacta/archivo.ts
@@ -42,7 +42,9 @@
 linea de contexto (sin cambios, empieza con espacio)
 otra linea de contexto
-linea que se elimina
+linea nueva que la reemplaza
+linea adicional si hace falta
 cierre de contexto
\`\`\`
3. **Incluye 3 lineas de contexto** arriba y abajo de cada cambio.
4. **Un bloque diff por archivo** — path correcto en cada bloque.
5. **Explica brevemente antes del diff** — que cambia y por que, en 1-2 oraciones.

## PROCESO DE RAZONAMIENTO
Antes de proponer codigo:
1. Lee el codigo existente — entiende la estructura, convenciones y patrones.
2. Identifica el problema o la tarea exacta.
3. Propone la solucion minima que funcione.
4. Si hay tests, asegurate de que el cambio no los rompa.
5. Si el cambio requiere dependencias nuevas, mencionalas explicitamente.

## FORMATO DE RESPUESTA
- Markdown rico: headers (##), listas, **negrita** para lo importante, \`codigo inline\`.
- Para bugs: **archivo** → **linea** → descripcion → diff.
- Para analisis: resumen ejecutivo → problemas criticos numerados → recomendaciones priorizadas.
- Para features: plan breve → implementacion paso a paso → diffs.
- Conciso y preciso. Cada oracion debe aportar valor.

## COMANDOS ESPECIALES
- \`Ejecuta: npm test\` — corre los tests y te devuelvo el resultado
- \`Ejecuta: npm install <paquete>\` — instala dependencias
- \`Ejecuta: git diff HEAD\` — muestra cambios actuales
- \`Ejecuta: git log --oneline -10\` — historial reciente`;

  if (repo) {
    sys += `\n\n## REPOSITORIO ACTIVO
- **Nombre**: ${repo}
- **Rama**: ${branch}
- **Archivos indexados**: ${fileCount}
- Los archivos relevantes ya fueron leidos y te los paso en el mensaje del usuario.`;
  }

  if (instructions) {
    sys += `\n\n## INSTRUCCIONES DEL PROYECTO (prioridad maxima)\n${instructions}`;
  }

  if (planMode) {
    sys += `\n\n## MODO PLAN ACTIVO
Antes de implementar CUALQUIER cambio:
1. Presenta un plan numerado con todos los archivos que vas a modificar
2. Explica el impacto de cada cambio
3. Espera confirmacion explicita del usuario ("ok", "adelante", "procede")
No generes ningun diff hasta recibir confirmacion.`;
  }

  return sys;
}

async function tryModel({ apiKey, model, messages, signal, onDelta }) {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://devagent.app',
      'X-Title': 'DevAgent',
    },
    signal,
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 4096,
      temperature: 0.1,
      stream: true,
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status}`;
    try { const b = await resp.json(); message = b.error?.message || b.error || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    err.providerError = true;
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
      } catch { /* SSE incompleto, ignorar */ }
    }
  }

  return result;
}

async function streamChat({ model, messages, signal, onDelta }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta OPENROUTER_API_KEY. Agrégala en las variables de entorno de Railway.');
    err.status = 503;
    throw err;
  }

  // Si el usuario especificó un modelo concreto, úsalo sin fallback
  if (model) return tryModel({ apiKey, model, messages, signal, onDelta });

  // Recorre la lista de modelos gratuitos hasta que uno funcione
  let lastErr;
  for (const candidate of FREE_MODELS) {
    try {
      console.log(`[OpenRouter] Probando modelo: ${candidate}`);
      return await tryModel({ apiKey, model: candidate, messages, signal, onDelta });
    } catch (e) {
      console.warn(`[OpenRouter] ${candidate} falló: ${e.message}`);
      lastErr = e;
      // Si fue abortado por el cliente no seguir intentando
      if (signal?.aborted) throw e;
    }
  }

  const err = new Error('Todos los modelos gratuitos fallaron. Último error: ' + lastErr?.message);
  err.status = 503;
  throw err;
}

async function checkHealth() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ready: false, model: DEFAULT_MODEL, error: 'OPENROUTER_API_KEY no configurada' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { ready: false, model: DEFAULT_MODEL, error: `HTTP ${r.status}` };
    return { ready: true, model: DEFAULT_MODEL };
  } catch (e) {
    return { ready: false, model: DEFAULT_MODEL, error: e.message };
  }
}

module.exports = { DEFAULT_MODEL, buildSystemPrompt, streamChat, checkHealth };

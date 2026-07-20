// ═══════════════════════════════════════════════════════
// ollamaClient.js
// Habla con Ollama (modelo local) desde el servidor.
// Sin API key, sin créditos, sin dependencias externas.
// Compatible con la API OpenAI que expone Ollama en
// http://localhost:11434/v1/chat/completions
// ═══════════════════════════════════════════════════════

const OLLAMA_BASE = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_URL  = `${OLLAMA_BASE}/v1/chat/completions`;

// Modelo a usar — puede cambiarse con la variable de entorno OLLAMA_MODEL
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';

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
3. **Incluye 3 lineas de contexto** arriba y abajo de cada cambio — si el contexto no coincide exactamente con el archivo, el patch falla.
4. **Un bloque diff por archivo** — si cambias multiples archivos, usa un bloque separado por cada uno con su path correcto.
5. **Explica brevemente antes del diff** — que cambia y por que, en 1-2 oraciones.

## PROCESO DE RAZONAMIENTO
Antes de proponer codigo:
1. Lee el codigo existente que se te paso — entiende la estructura, convenciones y patrones.
2. Identifica el problema o la tarea exacta.
3. Propone la solucion minima que funcione — no sobre-ingenierees.
4. Si hay tests, asegurate de que el cambio no los rompa.
5. Si el cambio requiere dependencias nuevas, mencionalas explicitamente.

## FORMATO DE RESPUESTA
- Markdown rico: headers (##), listas, **negrita** para lo importante, \`codigo inline\`.
- Para bugs: **archivo** → **linea** → descripcion → diff.
- Para analisis: resumen ejecutivo → problemas criticos numerados → recomendaciones priorizadas.
- Para features: plan breve → implementacion paso a paso → diffs.
- Conciso y preciso. Cada oracion debe aportar valor.

## COMANDOS ESPECIALES
Si necesitas ver el resultado de algo antes de continuar:
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

/**
 * Llama a Ollama en modo streaming via su API compatible con OpenAI.
 * Invoca onDelta(chunk, fullText) con cada fragmento nuevo.
 * Devuelve el texto completo al terminar.
 */
async function streamChat({ model, messages, signal, onDelta }) {
  const useModel = model || DEFAULT_MODEL;

  let resp;
  try {
    resp = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: useModel,
        messages,
        max_tokens: 4096,
        temperature: 0.1,
        stream: true,
      }),
    });
  } catch (e) {
    const err = new Error(
      'No se pudo conectar con Ollama. Asegurate de que el servicio esta corriendo. ' +
      (e.code === 'ECONNREFUSED' ? '(ECONNREFUSED en ' + OLLAMA_BASE + ')' : e.message)
    );
    err.status = 503;
    throw err;
  }

  if (!resp.ok) {
    let message = `Error ${resp.status} de Ollama`;
    try {
      const body = await resp.json();
      message = body.error?.message || body.error || message;
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
        // linea SSE incompleta o keepalive, ignorar
      }
    }
  }

  return result;
}

/**
 * Comprueba si Ollama está disponible y el modelo cargado.
 * Devuelve { ready: bool, model: string, error?: string }
 */
async function checkHealth() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ready: false, model: DEFAULT_MODEL, error: `HTTP ${r.status}` };
    const data = await r.json();
    const models = (data.models || []).map(m => m.name);
    const modelReady = models.some(m => m.startsWith(DEFAULT_MODEL.split(':')[0]));
    return { ready: true, model: DEFAULT_MODEL, modelReady, availableModels: models };
  } catch (e) {
    return { ready: false, model: DEFAULT_MODEL, error: e.message };
  }
}

module.exports = { DEFAULT_MODEL, buildSystemPrompt, streamChat, checkHealth };

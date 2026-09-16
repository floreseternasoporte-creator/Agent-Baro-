// ═══════════════════════════════════════════════════════
// computerTask.js
// El bucle agéntico de "uso de computadora" estilo Astra:
//
//   observar (captura real + árbol de accesibilidad)
//     → decidir (el modelo VE la pantalla vía visión, o lee la
//       estructura vía árbol) → actuar (clic/teclear/scroll)
//     → repetir hasta completar la tarea o agotar los pasos.
//
// Emite eventos `computer` con mode:'desktop' para que el
// frontend muestre la pantalla en vivo, paso a paso.
// ═══════════════════════════════════════════════════════

const { getAgentBrowser, requestConfirmation } = require('./computerUse');
const vision = require('./visionClient');

const MAX_STEPS = 12;
const VISION_TIMEOUT_MS = 600000; // la primera carga del modelo en CPU tarda minutos
const CONFIRM_TIMEOUT_MS = 1000 * 60 * 3; // 3 min para aprobar/denegar

const ALLOWED_ACTIONS = ['click', 'type', 'press', 'scroll', 'navigate', 'wait', 'done', 'fail', 'confirm'];

// Valida la decisión del modelo antes de ejecutarla: solo acciones
// conocidas y campos obligatorios presentes. Devuelve {ok, error}.
function validateDecision(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'decisión vacía' };
  if (!ALLOWED_ACTIONS.includes(d.action)) return { ok: false, error: `acción no permitida: ${d.action}` };
  if (['click', 'type'].includes(d.action) && !Number.isInteger(d.target)) {
    return { ok: false, error: `la acción ${d.action} requiere "target" (id de elemento)` };
  }
  if (d.action === 'type' && typeof d.text !== 'string') {
    return { ok: false, error: 'la acción type requiere "text"' };
  }
  if (d.action === 'press' && typeof d.key !== 'string') {
    return { ok: false, error: 'la acción press requiere "key"' };
  }
  if (d.action === 'navigate' && typeof d.url !== 'string') {
    return { ok: false, error: 'la acción navigate requiere "url"' };
  }
  return { ok: true };
}

function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function describeAction(d) {
  switch (d.action) {
    case 'click': return `Clic en elemento #${d.target}`;
    case 'type': return `Escribir en #${d.target}: "${String(d.text || '').slice(0, 60)}"`;
    case 'press': return `Tecla ${d.key || '?'}`;
    case 'scroll': return `Scroll ${Number(d.dy) >= 0 ? 'abajo' : 'arriba'} ${Math.abs(Number(d.dy) || 600)}px`;
    case 'navigate': return `Ir a ${d.url}`;
    case 'wait': return `Esperar ${d.ms || 1500}ms`;
    case 'confirm': return `Pedir aprobación: ${String(d.detail || d.reason || '').slice(0, 80)}`;
    case 'done': return 'Marcar tarea como completada';
    case 'fail': return 'Abandonar tarea';
    default: return `Acción desconocida: ${d.action}`;
  }
}

function formatElements(elements) {
  if (!elements.length) return '(no se detectaron elementos interactivos)';
  return elements.map((e) => `#${e.id} [${e.role}] "${e.name}" @(${e.x},${e.y})`).join('\n');
}

function formatPageText(text) {
  const t = String(text || '').trim();
  return t ? t.slice(0, 2500) : '(sin texto visible)';
}

function formatHistory(history) {
  if (!history.length) return '(sin acciones previas)';
  return history.slice(-6).map((h) => `Paso ${h.step}: ${h.action} → ${h.result}`).join('\n');
}

function decisionSystemPrompt() {
  return `Eres el piloto autónomo de un navegador web real. Ves la pantalla (captura) y la lista de elementos interactivos con sus coordenadas.
Responde SIEMPRE con un único objeto JSON, sin texto adicional, con esta forma:
{"action":"click|type|press|scroll|navigate|wait|confirm|done|fail","target":<id>,"text":"...","key":"Enter|Tab|Escape|Backspace","dy":600,"url":"https://...","ms":1500,"detail":"...","reason":"...","reasoning":"...","summary":"..."}
Reglas:
- "click": pulsa el elemento con ese id de la lista.
- "type": escribe text en el campo con ese id (primero hace clic en él). Para buscar: escribe el texto y luego "press" con key Enter.
- "press": pulsa una tecla (Enter, Tab, Escape, Backspace).
- "scroll": desplaza la página dy píxeles (positivo = abajo).
- "navigate": va a una URL (úsalo para empezar: ej. google.com).
- "wait": espera ms milisegundos (para que cargue algo).
- "confirm": ANTES de cualquier acción sensible o irreversible, emite esta acción con "detail" (qué vas a hacer) y "reason" (por qué es sensible). Acciones sensibles: comprar/pagar/finalizar compra, publicar/enviar mensajes o correos, borrar datos, escribir contraseñas o credenciales, descargar y ejecutar archivos, aceptar términos legales. El usuario verá tu petición y la aprobará o no; en el siguiente paso recibirás el resultado y podrás continuar con la acción real.
- "done": la tarea está CUMPLIDA; pon en summary el resultado para el usuario.
- "fail": no se puede completar; explica en summary.
- Sé eficiente: no repitas la acción anterior si no cambió nada; si una página no carga, prueba navigate a un buscador.
- NUNCA realices una acción sensible sin haber emitido "confirm" y recibido aprobación en el paso anterior.
- reasoning: una frase corta de por qué eliges esa acción.`;
}

async function decideWithVision({ task, step, history, obs, visionModel, generateText }) {
  // Arquitectura ojos + cerebro:
  // - OJOS (moondream, visión real): describe lo que VE en la captura.
  // - CEREBRO (modelo de texto): decide la acción en JSON estricto,
  //   combinando la descripción visual con el texto y los elementos.
  // Moondream es excelente describiendo píxeles pero malo obedeciendo
  // JSON; el modelo de texto es al revés. Cada uno hace lo suyo.
  let visual = '';
  try {
    visual = await vision.seeImage({
      imageBase64: obs.screenshot,
      prompt: 'Describe briefly what you see on this screen: main heading, visible text, buttons, links, forms. Be concise.',
      timeoutMs: VISION_TIMEOUT_MS,
    });
  } catch (e) {
    visual = `(la visión falló: ${e.message})`;
  }
  const prompt = `${decisionSystemPrompt()}

TAREA: ${task}
Paso ${step} de ${MAX_STEPS}. URL: ${obs.url} — ${obs.title}
Lo que el agente VE en la pantalla (descripción visual real):
${String(visual).slice(0, 1200)}
Texto visible de la página:
${formatPageText(obs.text)}
Historial reciente:
${formatHistory(history)}
Elementos interactivos:
${formatElements(obs.elements)}
Con la descripción visual y la lista de elementos, decide el siguiente paso. Responde SOLO el JSON.`;
  const raw = await generateText(prompt);
  return { decision: extractJson(raw), raw, visual };
}

async function decideWithText({ task, step, history, obs, generateText }) {
  const prompt = `${decisionSystemPrompt()}

TAREA: ${task}
Paso ${step} de ${MAX_STEPS}. URL: ${obs.url} — ${obs.title}
Texto visible de la página:
${formatPageText(obs.text)}
Historial reciente:
${formatHistory(history)}
Elementos interactivos (NO tienes captura: decide solo con esta lista y el texto):
${formatElements(obs.elements)}
Decide el siguiente paso. Responde SOLO el JSON.`;
  const raw = await generateText(prompt);
  return { decision: extractJson(raw), raw };
}

async function executeAction(browser, d) {
  switch (d.action) {
    case 'click': {
      const el = await browser.clickElement(d.target);
      return `clic en "${el.name}"`;
    }
    case 'type':
      await browser.typeText(d.target, d.text || '');
      return 'texto escrito';
    case 'press':
      await browser.pressKey(d.key || 'Enter');
      return `tecla ${d.key}`;
    case 'scroll':
      await browser.scroll(d.dy);
      return 'página desplazada';
    case 'navigate':
      await browser.navigate(d.url);
      return `navegado a ${d.url}`;
    case 'wait':
      await browser.wait(d.ms);
      return 'espera terminada';
    default:
      throw new Error(`Acción no soportada: ${d.action}`);
  }
}

/**
 * Ejecuta una tarea de computadora de principio a fin.
 * send: (kind, payload) — igual que el SSE del chat.
 * generateText: función del chat para el modo sin visión.
 */
async function runComputerTask({ task, session, send, generateText }) {
  const browser = await getAgentBrowser(session);
  const visionModel = await vision.visionAvailable();

  send('computer', {
    mode: 'desktop', action: 'start', task,
    vision: !!visionModel, visionModel: visionModel || null,
    maxSteps: MAX_STEPS,
  });
  send('log', {
    type: 'run',
    title: 'Modo computadora iniciado',
    detail: visionModel
      ? `El agente está VIENDO la pantalla con ${visionModel}.`
      : 'Visión no disponible: el agente trabaja con la estructura de la página.',
  });

  // Empezar en una página en blanco; el agente navega solo.
  try { await browser.navigate('about:blank'); } catch {}

  const history = [];
  let finalSummary = '';
  let completedOk = false;

  for (let step = 1; step <= MAX_STEPS; step++) {
    let obs;
    try {
      obs = await browser.observe();
    } catch (e) {
      send('computer', { mode: 'desktop', action: 'error', detail: `No se pudo observar la pantalla: ${e.message}` });
      break;
    }
    send('computer', {
      mode: 'desktop', action: 'observe', step,
      screenshot: obs.screenshot, url: obs.url, title: obs.title,
      elements: obs.elements.length,
    });

    // ── Decidir ──
    // decideConReintento: el tier gratuito a veces falla de forma
    // transitoria; un reintento evita abortar toda la tarea por un
    // hipo de red.
    async function decideConReintento() {
      let lastErr = null;
      for (let intento = 0; intento < 2; intento++) {
        try {
          if (visionModel) return await decideWithVision({ task, step, history, obs, visionModel, generateText });
          return await decideWithText({ task, step, history, obs, generateText });
        } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 2000)); }
      }
      throw lastErr;
    }
    let decision = null, visualDesc = '', mode = visionModel ? 'vision' : 'estructura';
    try {
      const r = await decideConReintento();
      decision = r.decision;
      visualDesc = r.visual || '';
    } catch (e) {
      // Si la visión falla a mitad, degradar a modo estructura con el modelo de texto.
      if (mode === 'vision') {
        send('log', { type: 'run', title: 'Visión lenta, usando estructura', detail: 'Sigo con el árbol de accesibilidad.' });
        mode = 'estructura';
        ({ decision } = await decideWithText({ task, step, history, obs, generateText }));
      } else {
        throw e;
      }
    }

    if (!decision || !decision.action) {
      history.push({ step, action: 'decidir', result: 'respuesta inválida del modelo, reintento observando' });
      send('computer', { mode: 'desktop', action: 'decide', step, mode, reasoning: 'Respuesta inválida; observo de nuevo.', act: 'wait' });
      await browser.wait(1500);
      continue;
    }

    // Validación estricta: solo acciones conocidas con sus campos.
    const validation = validateDecision(decision);
    if (!validation.ok) {
      history.push({ step, action: 'decidir', result: `decisión rechazada: ${validation.error}` });
      send('computer', { mode: 'desktop', action: 'decide', step, mode, reasoning: `Decisión inválida (${validation.error}); observo de nuevo.`, act: 'wait' });
      await browser.wait(1500);
      continue;
    }

    send('computer', {
      mode: 'desktop', action: 'decide', step, mode,
      reasoning: decision.reasoning || '', act: decision.action,
      detail: describeAction(decision),
      visual: visualDesc ? String(visualDesc).slice(0, 300) : undefined,
    });

    if (decision.action === 'done') {
      completedOk = true;
      finalSummary = decision.summary || 'Tarea completada.';
      break;
    }
    if (decision.action === 'fail') {
      finalSummary = decision.summary || 'No se pudo completar la tarea.';
      break;
    }

    // ── Confirmación para acciones sensibles ──
    // El agente pide permiso ANTES de comprar, publicar, enviar,
    // borrar o tocar credenciales. El usuario aprueba en el chat.
    if (decision.action === 'confirm') {
      const confirmId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const detail = String(decision.detail || decision.reason || 'acción sensible').slice(0, 300);
      send('computer', {
        mode: 'desktop', action: 'confirm-request',
        confirmId, detail, reason: decision.reason || '',
      });
      send('log', { type: 'run', title: 'Esperando tu aprobación', detail });
      let approved = false;
      try {
        approved = await requestConfirmation(session.id, confirmId, CONFIRM_TIMEOUT_MS);
      } catch (e) {
        approved = false;
      }
      send('computer', { mode: 'desktop', action: 'confirm-result', confirmId, approved });
      history.push({ step, action: `pedir aprobación: ${detail}`, result: approved ? 'aprobada por el usuario' : 'denegada o sin respuesta' });
      if (!approved) {
        finalSummary = `La tarea se detuvo: el usuario no aprobó la acción sensible ("${detail}").`;
        break;
      }
      continue; // aprobada: el agente decide el siguiente paso real
    }

    // ── Actuar ──
    try {
      const result = await executeAction(browser, decision);
      history.push({ step, action: describeAction(decision), result });
      send('computer', { mode: 'desktop', action: 'act', step, act: decision.action, detail: describeAction(decision), result });
    } catch (e) {
      history.push({ step, action: describeAction(decision), result: `error: ${e.message}` });
      send('computer', { mode: 'desktop', action: 'act', step, act: decision.action, detail: describeAction(decision), result: `Error: ${e.message}` });
    }
  }

  if (!finalSummary) {
    finalSummary = `Se agotaron los ${MAX_STEPS} pasos sin completar la tarea. Último estado: ${history.length ? history[history.length - 1].result : 'sin acciones'}.`;
  }

  let finalShot = null;
  try { finalShot = (await browser.observe()).screenshot; } catch {}

  send('computer', {
    mode: 'desktop', action: 'finish',
    ok: completedOk, summary: finalSummary, screenshot: finalShot,
  });
  return { ok: completedOk, summary: finalSummary };
}

module.exports = { runComputerTask, MAX_STEPS, validateDecision };

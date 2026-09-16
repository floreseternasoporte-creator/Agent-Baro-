// ═══════════════════════════════════════════════════════
// toolsClient.js
// Todo lo que convierte a DevAgent en algo más que "solo
// código": búsqueda web en tiempo real, Wikipedia, generación
// de video con IA (Seedance/BytePlus) y edición/animación de
// imágenes con IA. Cada función emite pasos vía un callback
// onStep(evento) para que el frontend pueda mostrar en vivo
// "qué está haciendo" el agente (qué página abrió, qué buscó,
// en qué paso va el video, etc).
//
// Todas las claves salen de variables de entorno. Ninguna
// clave se hardcodea ni se expone al navegador.
// ═══════════════════════════════════════════════════════

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────
// BÚSQUEDA WEB EN TIEMPO REAL — Tavily
// Elegida porque: tiene capa gratuita real (1000 créditos al
// mes, sin tarjeta), está diseñada para agentes de IA (ya
// entrega contenido extraído y limpio, no solo enlaces), y
// soporta filtrar por noticias/fecha, ideal para "qué está
// pasando ahora".
// Doc: https://docs.tavily.com
// ─────────────────────────────────────────────────────────
const TAVILY_URL = 'https://api.tavily.com/search';

async function webSearch({ query, topic = 'general', maxResults = 5, onStep }) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta TAVILY_API_KEY. Consigue una gratis en tavily.com y agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  onStep?.({ type: 'search_start', query, provider: 'Tavily' });

  const resp = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      topic, // 'general' | 'news'
      search_depth: 'advanced',
      max_results: Math.min(Math.max(maxResults, 1), 10),
      include_answer: true,
      include_images: false,
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} de Tavily`;
    try { message = (await resp.json()).error || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();

  // Emitimos cada resultado a medida que "lo abrimos", uno por uno,
  // para que la UI pueda pintar en vivo "Visitando: dominio.com"
  // como hace Perplexity, aunque la respuesta ya llegó completa —
  // esto es deliberado: da la sensación fiel de navegación real
  // sin inventar datos que Tavily no devolvió.
  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content?.slice(0, 600) || '',
    score: r.score,
  }));

  for (const r of results) {
    onStep?.({ type: 'search_visit', url: r.url, title: r.title, snippet: r.snippet });
  }

  onStep?.({ type: 'search_done', count: results.length });

  return {
    answer: data.answer || null,
    results,
  };
}

// ─────────────────────────────────────────────────────────
// WIKIPEDIA — API pública oficial, gratis, sin límites duros
// ni API key. Usamos el endpoint REST de resumen + el de
// búsqueda para encontrar el artículo correcto primero.
// Doc: https://api.wikimedia.org/wiki/API_reference/Core_REST_API
// ─────────────────────────────────────────────────────────
async function wikipediaLookup({ query, lang = 'es', onStep }) {
  onStep?.({ type: 'wiki_start', query });

  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`;
  const searchResp = await fetch(searchUrl, { headers: { 'User-Agent': 'DevAgent/1.0' } });
  if (!searchResp.ok) throw new Error(`Error ${searchResp.status} buscando en Wikipedia`);
  const searchData = await searchResp.json();
  const hit = searchData.query?.search?.[0];

  if (!hit) {
    onStep?.({ type: 'wiki_done', found: false });
    return { found: false, title: null, extract: null, url: null };
  }

  onStep?.({ type: 'wiki_visit', title: hit.title });

  const title = encodeURIComponent(hit.title.replace(/ /g, '_'));
  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`;
  const summaryResp = await fetch(summaryUrl, { headers: { 'User-Agent': 'DevAgent/1.0' } });
  if (!summaryResp.ok) throw new Error(`Error ${summaryResp.status} obteniendo resumen de Wikipedia`);
  const summary = await summaryResp.json();

  const result = {
    found: true,
    title: summary.title,
    extract: summary.extract,
    url: summary.content_urls?.desktop?.page || null,
    thumbnail: summary.thumbnail?.source || null,
  };

  onStep?.({ type: 'wiki_done', found: true, title: summary.title, extract: summary.extract, url: result.url });

  return result;
}

// ─────────────────────────────────────────────────────────
// GENERACIÓN DE VIDEO — Seedance (ByteDance) vía BytePlus
// ModelArk. Es un servicio DE PAGO por segundo generado — no
// existe un tier gratuito real de producción para video con
// IA en ningún proveedor serio; se paga con la key del propio
// usuario (BYTEPLUS_API_KEY).
//
// Límite técnico real de Seedance: 15s por clip (Seedance 2.0)
// o 30s (Seedance 2.5) en una sola generación. Para pedidos más
// largos (hasta el máximo soportado de una "película" corta de
// hasta 10 minutos), se ENCADENAN varias generaciones usando el
// último frame del clip anterior como referencia del siguiente,
// controlado por MAX_CLIP_SECONDS/MAX_TOTAL_SECONDS abajo.
// ─────────────────────────────────────────────────────────
const BYTEPLUS_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const SEEDANCE_MODEL = process.env.SEEDANCE_MODEL || 'seedance-2-0-pro-250628';

const MAX_CLIP_SECONDS = 15;              // límite real de una sola generación
const MAX_TOTAL_SECONDS = 10 * 60;        // tope duro pedido por el usuario: 10 min
const MAX_VIDEOS_PER_DAY = 10;            // tope duro pedido por el usuario

// Contador diario en memoria (por proceso). Para producción con
// múltiples usuarios reales, esto debería vivir en una base de
// datos o Redis compartido; aquí se deja simple y documentado.
const dailyVideoUsage = new Map(); // key: 'YYYY-MM-DD' -> count

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getVideoUsageToday() {
  return dailyVideoUsage.get(todayKey()) || 0;
}

function checkAndReserveVideoQuota() {
  const key = todayKey();
  const used = dailyVideoUsage.get(key) || 0;
  if (used >= MAX_VIDEOS_PER_DAY) {
    const err = new Error(`Límite diario de ${MAX_VIDEOS_PER_DAY} videos alcanzado. Vuelve a intentarlo mañana.`);
    err.status = 429;
    throw err;
  }
  dailyVideoUsage.set(key, used + 1);
  return MAX_VIDEOS_PER_DAY - (used + 1);
}

function releaseVideoQuota() {
  const key = todayKey();
  const used = dailyVideoUsage.get(key) || 0;
  if (used > 0) dailyVideoUsage.set(key, used - 1);
}

async function submitSeedanceClip({ apiKey, prompt, durationSec, referenceImageUrl }) {
  const content = [{ type: 'text', text: `${prompt} --dur ${durationSec} --resolution 720p` }];
  if (referenceImageUrl) {
    content.push({ type: 'image_url', image_url: { url: referenceImageUrl } });
  }

  const resp = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: SEEDANCE_MODEL, content }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} de Seedance/BytePlus`;
    try { message = (await resp.json()).error?.message || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  return data.id; // task id para hacer polling
}

async function pollSeedanceTask({ apiKey, taskId, onStep, clipIndex }) {
  const started = Date.now();
  const timeoutMs = 6 * 60 * 1000; // 6 min de margen por clip

  while (Date.now() - started < timeoutMs) {
    const resp = await fetch(`${BYTEPLUS_BASE}/contents/generations/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) throw new Error(`Error ${resp.status} consultando estado del video`);
    const data = await resp.json();

    if (data.status === 'succeeded') {
      onStep?.({ type: 'video_clip_ready', clipIndex, url: data.content?.video_url });
      return data.content?.video_url;
    }
    if (data.status === 'failed') {
      throw new Error(data.error?.message || 'La generación de video falló en el proveedor.');
    }

    onStep?.({ type: 'video_clip_progress', clipIndex, status: data.status || 'processing' });
    await new Promise((r) => setTimeout(r, 4000));
  }

  throw new Error('Tiempo de espera agotado generando el clip de video.');
}

/**
 * Genera un video, encadenando clips de hasta MAX_CLIP_SECONDS
 * hasta cubrir `durationSec` (tope MAX_TOTAL_SECONDS = 10 min).
 * Respeta el límite de MAX_VIDEOS_PER_DAY por instancia del
 * servidor. onStep(evento) reporta cada paso en tiempo real.
 */
async function generateVideo({ prompt, durationSec = 15, referenceImageUrl = null, onStep }) {
  const apiKey = process.env.BYTEPLUS_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta BYTEPLUS_API_KEY. Consigue una key de Volcengine/BytePlus ModelArk (servicio de pago, no hay tier gratis real para video con IA) y agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  const targetSeconds = Math.min(Math.max(durationSec, 3), MAX_TOTAL_SECONDS);
  const remaining = checkAndReserveVideoQuota(); // lanza si se agotó la cuota

  onStep?.({ type: 'video_start', targetSeconds, remainingToday: remaining });

  const clips = [];
  let secondsLeft = targetSeconds;
  let clipIndex = 0;
  let lastClipUrl = referenceImageUrl;

  try {
    while (secondsLeft > 0) {
      const clipDuration = Math.min(secondsLeft, MAX_CLIP_SECONDS);
      clipIndex += 1;
      onStep?.({ type: 'video_clip_start', clipIndex, clipDuration });

      const taskId = await submitSeedanceClip({
        apiKey,
        prompt: clipIndex === 1 ? prompt : `${prompt} (continuación de la escena anterior, misma consistencia de personajes y estilo)`,
        durationSec: clipDuration,
        referenceImageUrl: clipIndex === 1 ? referenceImageUrl : lastClipUrl,
      });

      const clipUrl = await pollSeedanceTask({ apiKey, taskId, onStep, clipIndex });
      clips.push({ index: clipIndex, url: clipUrl, seconds: clipDuration });
      lastClipUrl = clipUrl;
      secondsLeft -= clipDuration;
    }

    onStep?.({ type: 'video_done', clips: clips.length, totalSeconds: targetSeconds });
    return { clips, totalSeconds: targetSeconds, remainingToday: remaining };
  } catch (e) {
    releaseVideoQuota(); // no consumir cuota si terminó en error
    throw e;
  }
}

// ─────────────────────────────────────────────────────────
// EDICIÓN / ANIMACIÓN DE IMÁGENES CON IA
// Usa un modelo de imagen a través de OpenRouter (mismo
// proveedor que ya usa el chat como fallback), que expone
// modelos de edición/generación de imágenes por texto. Sirve
// para: "edítame estas fotos", "anímame esta imagen" (esto
// último delega a generateVideo con referenceImageUrl).
// ─────────────────────────────────────────────────────────
const OPENROUTER_IMAGE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const IMAGE_EDIT_MODEL = process.env.IMAGE_EDIT_MODEL || 'google/gemini-2.5-flash-image-preview';

async function editImage({ imageUrl, instruction, onStep }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('Falta OPENROUTER_API_KEY para edición de imágenes. Agrégala en las variables de entorno del servidor.');
    err.status = 503;
    throw err;
  }

  onStep?.({ type: 'image_edit_start', instruction });

  const resp = await fetch(OPENROUTER_IMAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_EDIT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      }],
      modalities: ['image', 'text'],
    }),
  });

  if (!resp.ok) {
    let message = `Error ${resp.status} editando la imagen`;
    try { message = (await resp.json()).error?.message || message; } catch {}
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const choice = data.choices?.[0]?.message;
  const outputImage = choice?.images?.[0]?.image_url?.url || null;

  onStep?.({ type: 'image_edit_done', hasImage: !!outputImage });

  return {
    imageUrl: outputImage,
    note: choice?.content || null,
  };
}

/** Procesa un lote de imágenes con la misma instrucción, en secuencia,
 *  reportando progreso por cada una. */
async function editImageBatch({ images, instruction, onStep }) {
  const results = [];
  for (let i = 0; i < images.length; i += 1) {
    onStep?.({ type: 'batch_item_start', index: i, total: images.length });
    try {
      const result = await editImage({ imageUrl: images[i], instruction, onStep });
      results.push({ index: i, ok: true, ...result });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message });
    }
    onStep?.({ type: 'batch_item_done', index: i, total: images.length });
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// GENERACIÓN DE IMÁGENES — Pollinations (GRATIS, SIN CLAVE)
// Verificado en vivo 2026-09-16: GET
// https://image.pollinations.ai/prompt/<prompt>?width=&height=&model=flux
// devuelve la imagen generada directamente (HTTP 200,
// image/jpeg), sin autenticacion. El propio GET dispara la
// generacion, asi que la URL resultante ES el resultado y se
// puede mostrar tal cual en el frontend.
// ─────────────────────────────────────────────────────────
const IMAGE_GEN_MODEL = process.env.IMAGE_GEN_MODEL || 'flux';

function buildImageUrl(prompt, { width = 1024, height = 1024, seed = null } = {}) {
  const s = seed ?? Math.floor(Math.random() * 1_000_000_000);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(s),
    model: IMAGE_GEN_MODEL,
    nologo: 'true',
    private: 'true',
  });
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

/**
 * Genera una imagen con IA sin necesidad de clave.
 * onStep(evento): image_start { prompt } -> image_done { url }.
 * Devuelve { imageUrl, prompt }. La generacion ocurre al
 * resolverse la URL (el servidor de Pollinations la genera
 * al recibir el GET); aqui solo construimos la URL real.
 */
async function generateImage({ prompt, width, height, onStep }) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error('Falta el prompt para generar la imagen.');
  }
  onStep?.({ type: 'image_start', prompt: String(prompt).trim() });
  const imageUrl = buildImageUrl(String(prompt).trim(), { width, height });
  onStep?.({ type: 'image_done', url: imageUrl });
  return { imageUrl, prompt: String(prompt).trim() };
}

// ─────────────────────────────────────────────────────────
// DOCUMENT STUDIO — documentos, presentaciones y hojas de
// cálculo REALES (.docx / .pptx / .xlsx), como las que crea
// el modo agente de ChatGPT/Astra. Sin clave, sin servicios
// externos: el contenido lo redacta la IA del agente y aquí
// se convierte a archivo Office de verdad, descargable.
// onStep(evento): doc_start { kind, title } ->
//   doc_content (redactando) -> doc_done { fileName, bytes }.
// Devuelve { fileName, bytes, downloadUrl, kind, title }.
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const PptxGenJS = require('pptxgenjs');
const ExcelJS = require('exceljs');

const DOC_KINDS = {
  documento: { ext: 'docx', label: 'documento' },
  presentacion: { ext: 'pptx', label: 'presentación' },
  hoja: { ext: 'xlsx', label: 'hoja de cálculo' },
};

function slugifyFileName(s) {
  return String(s || 'documento')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'documento';
}

// Divide el markdown en bloques simples: h1/h2/h3/viñeta/párrafo.
function parseDocBlocks(md) {
  const blocks = [];
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^###\s+(.*)/))) blocks.push({ type: 'h3', text: m[1] });
    else if ((m = line.match(/^##\s+(.*)/))) blocks.push({ type: 'h2', text: m[1] });
    else if ((m = line.match(/^#\s+(.*)/))) blocks.push({ type: 'h1', text: m[1] });
    else if ((m = line.match(/^[-*]\s+(.*)/))) blocks.push({ type: 'li', text: m[1] });
    else if (/^\|.*\|$/.test(line)) continue; // las tablas se manejan aparte en hojas
    else if (/^---+$/.test(line)) continue;
    else blocks.push({ type: 'p', text: line.replace(/\*\*/g, '') });
  }
  return blocks;
}

// Convierte **negrita** en segmentos { text, bold }.
function inlineSegments(text) {
  const segs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.length ? segs : [{ text }];
}

function docxParagraph(block) {
  const runs = inlineSegments(block.text).map((s) => new TextRun({ text: s.text, bold: !!s.bold, size: 22 }));
  if (block.type === 'h1') return new Paragraph({ heading: HeadingLevel.HEADING_1, children: runs });
  if (block.type === 'h2') return new Paragraph({ heading: HeadingLevel.HEADING_2, children: runs });
  if (block.type === 'h3') return new Paragraph({ heading: HeadingLevel.HEADING_3, children: runs });
  if (block.type === 'li') return new Paragraph({ bullet: { level: 0 }, children: runs });
  return new Paragraph({ children: runs });
}

async function buildDocxFile(title, blocks, fullPath) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, size: 52, bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: ' ', size: 16 })] }),
        ...blocks.map(docxParagraph),
      ],
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(fullPath, buffer);
}

async function buildPptxFile(title, blocks, fullPath) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';
  // Diapositiva de título
  const cover = pptx.addSlide();
  cover.background = { color: '1B1B22' };
  cover.addText(title, { x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center' });
  cover.addText('Generado por DevAgent', { x: 0.8, y: 4.2, w: 11.7, h: 0.6, fontSize: 16, color: '9A9AAD', align: 'center' });
  // Una diapositiva por cada ## (o #), con sus viñetas
  let current = null;
  const slides = [];
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2') { current = { title: b.text, bullets: [] }; slides.push(current); }
    else if (current && (b.type === 'li' || b.type === 'p')) current.bullets.push(b.text);
    else if (!current && b.type === 'p') { current = { title: title, bullets: [b.text] }; slides.push(current); }
  }
  for (const s of slides.slice(0, 20)) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(s.title, { x: 0.7, y: 0.4, w: 11.9, h: 1.0, fontSize: 30, bold: true, color: '1B1B22' });
    if (s.bullets.length) {
      slide.addText(s.bullets.map((t) => ({ text: t, options: { bullet: { indent: 18 }, breakLine: true } })),
        { x: 0.9, y: 1.7, w: 11.5, h: 5.2, fontSize: 18, color: '333333', valign: 'top' });
    }
  }
  await pptx.writeFile({ fileName: fullPath });
}

// Extrae la primera tabla markdown (| a | b |) para la hoja.
function parseMarkdownTable(md) {
  const rows = [];
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\|.*\|$/.test(line)) continue;
    if (/^\|[\s|:-]+\|$/.test(line)) continue; // fila separadora
    rows.push(line.split('|').slice(1, -1).map((c) => c.trim().replace(/\*\*/g, '')));
  }
  return rows.filter((r) => r.length > 0);
}

async function buildXlsxFile(title, md, fullPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DevAgent';
  const ws = wb.addWorksheet(slugifyFileName(title).slice(0, 28) || 'Hoja1');
  const table = parseMarkdownTable(md);
  if (table.length) {
    const header = table[0];
    ws.addRow(header);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C5CFF' } };
    for (const row of table.slice(1, 200)) ws.addRow(row);
    ws.columns = header.map((h) => ({ width: Math.min(42, Math.max(14, String(h).length + 4)) }));
  } else {
    // Sin tabla: vuelca los bloques como lista en la columna A.
    ws.addRow([title]);
    ws.getRow(1).font = { bold: true, size: 14 };
    for (const b of parseDocBlocks(md).slice(0, 300)) ws.addRow([b.text]);
    ws.getColumn(1).width = 90;
  }
  await wb.xlsx.writeFile(fullPath);
}

function docPromptFor(kind, title, brief) {
  const extra = brief ? `\nEnfoque/contenido pedido: ${brief}` : '';
  if (kind === 'presentacion') {
    return `Escribe el contenido de una presentación profesional en español sobre: "${title}".${extra}\n\nFormato markdown estricto:\n- Cada diapositiva empieza con ## seguido del título de la diapositiva\n- Debajo, de 3 a 5 viñetas con "- " (frases cortas, impactantes)\n- Entre 6 y 10 diapositivas\n- Nada de introducciones ni comentarios meta: SOLO el contenido markdown.`;
  }
  if (kind === 'hoja') {
    return `Genera los datos de una hoja de cálculo en español sobre: "${title}".${extra}\n\nFormato markdown estricto:\n- SOLO una tabla markdown: primera línea con encabezados entre | |, segunda línea con |---|, luego de 8 a 20 filas de datos realistas\n- Nada de texto fuera de la tabla: ni introducción ni comentarios.`;
  }
  return `Escribe un documento profesional en español sobre: "${title}".${extra}\n\nFormato markdown estricto:\n- Empieza con # seguido del título\n- Secciones con ##, párrafos desarrollados y listas con "- " donde ayuden\n- Tono claro y útil, contenido sustancial (no relleno)\n- Nada de comentarios meta: SOLO el contenido del documento.`;
}

async function generateDocument({ kind, title, brief, sessionId, sessionDir, generateText, onStep }) {
  const def = DOC_KINDS[kind];
  if (!def) throw new Error(`Tipo de documento desconocido: ${kind}`);
  const cleanTitle = String(title || 'Sin título').trim();
  if (!cleanTitle) throw new Error('Falta el título del documento.');
  if (typeof generateText !== 'function') throw new Error('generateDocument necesita generateText (IA).');

  onStep?.({ type: 'doc_start', kind, title: cleanTitle });
  onStep?.({ type: 'doc_content', detail: 'redactando contenido con IA' });
  const md = await generateText(docPromptFor(kind, cleanTitle, brief));
  if (!md || !md.trim()) throw new Error('La IA no devolvió contenido para el documento.');

  const docsDir = path.join(sessionDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const fileName = `${slugifyFileName(cleanTitle)}.${def.ext}`;
  const fullPath = path.join(docsDir, fileName);

  onStep?.({ type: 'doc_build', detail: `construyendo ${fileName}` });
  if (kind === 'presentacion') await buildPptxFile(cleanTitle, parseDocBlocks(md), fullPath);
  else if (kind === 'hoja') await buildXlsxFile(cleanTitle, md, fullPath);
  else await buildDocxFile(cleanTitle, parseDocBlocks(md), fullPath);

  const bytes = fs.statSync(fullPath).size;
  onStep?.({ type: 'doc_done', kind, title: cleanTitle, fileName, bytes });
  return {
    kind, title: cleanTitle, fileName, bytes,
    downloadUrl: `/api/files/download?sessionId=${encodeURIComponent(sessionId)}&file=${encodeURIComponent('docs/' + fileName)}`,
  };
}

module.exports = {
  webSearch,
  wikipediaLookup,
  generateVideo,
  generateImage,
  generateDocument,
  editImage,
  editImageBatch,
  getVideoUsageToday,
  MAX_VIDEOS_PER_DAY,
  MAX_TOTAL_SECONDS,
  MAX_CLIP_SECONDS,
};

// ═══════════════════════════════════════════════════════
// server.js
// Punto de entrada. Sirve el frontend (index.html/script.js/
// style.css, en esta misma carpeta) y expone la API real
// del agente bajo /api/*. Esto es lo que Railway arranca con
// "npm start".
// ═══════════════════════════════════════════════════════

try { require('dotenv').config(); } catch (_) { /* en Railway las vars ya están inyectadas, dotenv es opcional */ }

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const { sweepExpired, WORKSPACES_ROOT } = require('./sessionStore');

const repoRoutes = require('./repoRoutes');
const chatRoutes = require('./chatRoutes');
const agentRoutes = require('./agentRoutes');
const authRoutes = require('./authRoutes');
const toolsRoutes = require('./toolsRoutes');

const groq = require('./groqClient');
const ollama = require('./ollamaClient');
const pollinations = require('./pollinationsClient');
const feedbackRoutes = require('./feedbackRoutes');
const visionClient = require('./visionClient');
const { closeAgentBrowser } = require('./computerUse');

const app = express();
app.set('trust proxy', 1);   // Requerido para express-rate-limit detrás de Railway proxy
const PORT = process.env.PORT || 3000;
// index.html vive en esta misma carpeta (todo el proyecto es plano,
// sin subcarpetas), asi que la raiz del proyecto es __dirname mismo.
const PROJECT_ROOT = __dirname;

// ── Seguridad basica de servidor publico ──────────────────
app.disable('x-powered-by');
// CORS: ANTES reflejaba CUALQUIER origen (origin: true) cuando no se
// definia CORS_ORIGIN — cualquier web podia usar tu instancia como
// proxy gratuito y quemar tus claves de Groq. Ahora, por
// defecto, solo mismo-origen (el frontend vive en este mismo servidor,
// asi que no necesita CORS). Define CORS_ORIGIN con dominios
// explicitos solo si sirves el frontend desde otro dominio.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : false;
app.use(cors({ origin: corsOrigins || false }));
app.use(express.json({ limit: '2mb' }));

// Token opcional para la API: si defines AGENT_API_TOKEN, todo /api/*
// (menos /api/health) exige la cabecera `x-agent-token` con ese valor.
// Util si expones la instancia en internet y no quieres que extraños
// consuman tus claves de IA. El frontend lo envia solo si existe en
// localStorage bajo la clave 'agent_token'.
const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN || null;
app.use('/api', (req, res, next) => {
  if (!AGENT_API_TOKEN) return next();
  if (req.path === '/health') return next();
  if (req.headers['x-agent-token'] === AGENT_API_TOKEN) return next();
  return res.status(401).json({ error: 'No autorizado: falta o es invalido x-agent-token.' });
});

// El chat/comandos/push pegan a GitHub y Ollama, asi que van con
// rate limit para que una sola sesion no agote la instancia.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, espera un momento.' },
});
app.use('/api', apiLimiter);

// ── Workspaces (clones de repos reales) ───────────────────
if (!fs.existsSync(WORKSPACES_ROOT)) fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });

// ── API real del agente ───────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', repoRoutes);
app.use('/api', chatRoutes);
app.use('/api', agentRoutes);
app.use('/api', feedbackRoutes);
app.use('/api', toolsRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'baro', time: new Date().toISOString() });
});

app.get('/api/config', async (_req, res) => {
  // Cadena real de proveedores (misma que usa /api/chat con failover),
  // 100% gratuita: Groq (gratis con key) > Pollinations (GRATIS, sin
  // clave, siempre disponible) > Ollama local. El chat NUNCA muere
  // por falta de claves: sin GROQ_API_KEY responde igual.
  const chain = [];
  if (process.env.GROQ_API_KEY) chain.push('Groq');
  chain.push('Pollinations (gratis)');
  chain.push('Ollama local');
  const providerName = chain[0];
  // El cliente "principal" es el primero de la cadena que tenga key.
  const client = process.env.GROQ_API_KEY ? groq : pollinations;
  const ai = await client.checkHealth();
  res.json({
    ollamaReady: ai.ready, // legacy: en realidad es el health del cliente principal
    ollamaModel: ai.model, // legacy: en realidad es el modelo del cliente principal
    aiReady: ai.ready,
    aiModel: ai.model,
    aiProvider: providerName,
    providerChain: chain,
    freeProvider: 'Pollinations (gratis)',
    authTokenRequired: !!process.env.AGENT_API_TOKEN,
    serverTime: new Date().toISOString(),
    githubPreconfigured: !!process.env.GITHUB_TOKEN,
    githubOAuthEnabled: !!process.env.GITHUB_CLIENT_ID,
    tools: {
      webSearch: !!process.env.TAVILY_API_KEY,
      deepResearch: !!process.env.TAVILY_API_KEY,
      wikipedia: true, // API pública, no requiere key
      video: !!process.env.BYTEPLUS_API_KEY,
      imageEdit: true, // Pollinations: gratis, sin clave, siempre
      imageGen: true, // Pollinations/FLUX: gratis, sin clave, siempre
      voice: true, // Web Speech API del navegador: dictado + lectura, sin clave
      voiceMode: true, // conversación continua por voz (habla <-> escucha), sin clave
      memory: true, // memoria a largo plazo por sesion, en disco
      documents: true, // Document Studio: .docx/.pptx/.xlsx reales, sin clave
      parallelTools: true, // multitarea: herramientas independientes en paralelo
      longContext: true, // compactación automática del historial largo
      computerUse: true, // modo computadora: Chromium real que el agente ve y controla
      vision: await visionClient.visionAvailable().catch(() => null), // modelo de visión local (ojos del agente) o null
    },
  });
});

// ── Frontend estatico (todo el proyecto vive en esta misma carpeta) ────
// IMPORTANTE: al no haber subcarpetas, index.html/script.js/style.css
// conviven en el mismo directorio que el codigo del backend
// (server.js, gitAgent.js, etc). express.static serviria TODO por
// igual si no se filtra, permitiendo descargar el codigo fuente del
// servidor con un GET directo (ej. /gitAgent.js). Esta lista blanca
// evita eso: solo estos archivos y extensiones se sirven como estaticos.
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'script.js', 'firebase-auth.js']);
const PUBLIC_EXT_RE = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf)$/i;

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const requested = req.path.replace(/^\//, '') || 'index.html';
  if (PUBLIC_FILES.has(requested) || PUBLIC_EXT_RE.test(requested)) return next();
  // Un .js que no esta en la whitelist es casi siempre alguien
  // pidiendo codigo del backend a proposito (ej. /gitAgent.js) —
  // 404 real, no el HTML del frontend con codigo 200.
  if (/\.js$/i.test(requested)) return res.status(404).json({ error: 'No encontrado' });
  return res.sendFile(path.join(PROJECT_ROOT, 'index.html'));
});

app.use(express.static(PROJECT_ROOT, { index: 'index.html', extensions: ['html'] }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PROJECT_ROOT, 'index.html'));
});

// ── Manejo de errores centralizado ────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[devagent] error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  console.log(`DevAgent escuchando en el puerto ${PORT}`);
});

// Limpieza de sesiones/workspaces viejos cada hora, para no
// llenar el disco de Railway con clones abandonados.
setInterval(() => {
  sweepExpired((session) => {
    fs.rm(session.dir, { recursive: true, force: true }, () => {});
    // Cerrar también el navegador del modo computadora de esa sesión.
    closeAgentBrowser(session.id).catch(() => {});
    console.log(`[devagent] sesion expirada limpiada: ${session.id}`);
  });
}, 1000 * 60 * 60);

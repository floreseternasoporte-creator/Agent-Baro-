// ═══════════════════════════════════════════════════════
// server.js
// Punto de entrada. Sirve el frontend (index.html/script.js/
// style.css, en esta misma carpeta) y expone la API real
// del agente bajo /api/*. Esto es lo que Railway arranca con
// "npm start".
// ═══════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const { sweepExpired, WORKSPACES_ROOT } = require('./sessionStore');

const repoRoutes = require('./repoRoutes');
const chatRoutes = require('./chatRoutes');
const agentRoutes = require('./agentRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
// index.html vive en esta misma carpeta (todo el proyecto es plano,
// sin subcarpetas), asi que la raiz del proyecto es __dirname mismo.
const PROJECT_ROOT = __dirname;

// ── Seguridad basica de servidor publico ──────────────────
app.disable('x-powered-by');
app.use(cors({ origin: process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN ? true : process.env.CORS_ORIGIN.split(',') }));
app.use(express.json({ limit: '2mb' }));

// El chat/comandos/push pegan a GitHub y Groq, asi que van con
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
app.use('/api', repoRoutes);
app.use('/api', chatRoutes);
app.use('/api', agentRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'devagent', time: new Date().toISOString() });
});

app.get('/api/config', (_req, res) => {
  // Le dice al frontend que capacidades ya vienen preconfiguradas
  // desde el servidor, para no pedirle claves al usuario si no hace falta.
  res.json({
    groqPreconfigured: !!process.env.GROQ_API_KEY,
    githubPreconfigured: !!process.env.GITHUB_TOKEN,
  });
});

// ── Frontend estatico (todo el proyecto vive en esta misma carpeta) ────
// IMPORTANTE: al no haber subcarpetas, index.html/script.js/style.css
// conviven en el mismo directorio que el codigo del backend
// (server.js, gitAgent.js, etc). express.static serviria TODO por
// igual si no se filtra, permitiendo descargar el codigo fuente del
// servidor con un GET directo (ej. /gitAgent.js). Esta lista blanca
// evita eso: solo estos archivos y extensiones se sirven como estaticos.
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'script.js']);
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
    console.log(`[devagent] sesion expirada limpiada: ${session.id}`);
  });
}, 1000 * 60 * 60);

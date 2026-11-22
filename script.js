// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
// ID local persistente usado solo para restaurar el historial de chat del
// navegador; no se envía al backend ni identifica al usuario.
function getClientId() {
  try {
    let id = localStorage.getItem('devagent_client_id');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || '')) {
      id = 'c-' + Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('devagent_client_id', id);
    }
    return id;
  } catch {
    return null;
  }
}

const S = {
  busy: false,
  ok: false,
  repoData: null,
  files: [],
  branch: 'main',
  instructions: '',
  history: [],
  pendingEdits: [],
  multiAgentEnabled: true,
  planModeEnabled: false,
  fileLimit: 10,
  abortController: null,
  currentScreen: 'chat',
  currentFile: null,
  totalTokens: 0,
  maxTokens: 131072,
  sessionId: null,       // id de la sesion/workspace real en el servidor
  clientId: getClientId(), // clave local del historial de chat
  serverConfig: null,    // { ollamaReady, ollamaModel, aiProvider, githubPreconfigured }
  lastAutoAppliedPaths: [],
  lastAppliedDiffs: [],
  applyMode: 'auto',     // 'auto' = aplica diffs solo · 'ask' = Preguntar (el usuario aplica)
  planSteps: [],         // pasos del plan del turno (evento SSE "plan")
  lastVerify: null,      // ultimo resultado de tests (evento SSE "verify")
  currentThreadId: null, // conversación abierta (servidor, FASE 3)
  currentJobId: null,    // trabajo en curso, si lo hay (H2)
  threads: [],           // lista real de conversaciones del usuario
  activeJobs: [],        // trabajos en curso o en cola (H2)
};

// Base de la API real. Mismo origen que sirve el frontend
// (el backend de Express sirve ambas cosas), asi que en
// Railway esto simplemente funciona sin configuracion extra.
const API = '/api';
const BLOB_URL_REVOKE_DELAY_MS = 1000;

// ═══════════════════════════════════════════
// FUENTE UNICA DE TAREAS RAPIDAS
// Antes esto estaba repetido a mano en dos pantallas
// distintas (#empty y #screen-tasks) con textos casi
// identicos que se podian desincronizar. Ahora vive UNA
// sola vez aqui y ambas pantallas se pintan desde esta
// misma lista con renderQuickCards()/renderTaskList().
// ═══════════════════════════════════════════
// Acciones rapidas del inicio: UNA sola lista por seccion para que
// el inicio (#empty) y la pantalla Tareas se pinten igual sin
// desincronizarse. Baro es un agente de proposito general: la
// seccion "Crear" no necesita repositorio (documentos, scripts
// Python que se ejecutan de verdad, imagenes, video...).
// ═══════════════════════════════════════════
const QUICK_TASKS = {
  create: [
    {
      id: 'doc', color: 'blue', title: 'Crear documento', sub: 'Word real y descargable',
      icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
      prompt: 'Crear documento: ',
    },
    {
      id: 'pyscript', color: 'green', title: 'Crear código', sub: 'Lo escribo y lo ejecuto',
      icon: '<path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
      prompt: 'Quiero un código que ',
    },
    {
      id: 'image', color: 'amber', title: 'Crear imagen', sub: 'Describe lo que imaginas',
      icon: '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
      prompt: 'Generar imagen: ',
    },
    {
      id: 'video', color: 'purple', title: 'Generar video', sub: 'Vídeo corto a partir de texto',
      icon: '<path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>',
      prompt: 'Generar video: ',
    },
    {
      id: 'sheet', color: 'green', title: 'Hoja de cálculo', sub: 'Excel real y descargable',
      icon: '<path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/>',
      prompt: 'Hoja de cálculo: ',
    },
    {
      id: 'slides', color: 'red', title: 'Presentación', sub: 'PowerPoint descargable',
      icon: '<path d="M20 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/>',
      prompt: 'Crear presentación: ',
    },
  ],
  investigate: [
    {
      id: 'deepresearch', color: 'red', title: 'Investigación profunda', sub: 'Informe con fuentes citadas',
      icon: '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
      prompt: 'Investigación profunda: ',
    },
    {
      id: 'websearch', color: 'blue', title: 'Buscar en internet', sub: 'Resultados en tiempo real',
      icon: '<path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>',
      prompt: 'Buscar: ',
    },
    {
      id: 'wikipedia', color: 'green', title: 'Buscar un dato', sub: 'Respuestas rápidas con fuentes',
      icon: '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zM4.34 16h3.02c.2.9.55 1.76 1.03 2.56A8.03 8.03 0 0 1 4.34 16zM8.56 8H5.61a8.03 8.03 0 0 1 4.03-3.56C9.17 5.24 8.72 6.55 8.56 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM13.34 14H10.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h2.68c.09.65.16 1.32.16 2 0 .68-.07 1.35-.16 2zm.25 5.56c.48-.8.83-1.66 1.03-2.56h3.02a8.03 8.03 0 0 1-4.05 2.56zM15.45 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.29c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.29z"/>',
      prompt: 'Busca un dato sobre ',
    },
    {
      id: 'imageedit', color: 'amber', title: 'Editar/animar imagen', sub: 'Sube o pega una URL',
      icon: '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
      prompt: 'Editar imagen: ',
    },
  ],
  code: [
    {
      id: 'analyze', color: 'accent', title: 'Analizar repo', sub: 'Arquitectura y tecnologías', needsRepo: true,
      icon: '<path d="M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z"/>',
      prompt: 'Analiza el repositorio completo: arquitectura, tecnologías usadas, patrones de diseño usados, dependencias clave y los 5 problemas más importantes con recomendaciones.',
    },
    {
      id: 'bugs', color: 'green', title: 'Detectar bugs', sub: 'Con el cambio exacto', needsRepo: true,
      icon: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>',
      prompt: 'Detecta y corrige todos los bugs del proyecto. Para cada bug muestra: archivo, linea exacta, descripcion del problema y el cambio exacto para arreglarlo.',
    },
    {
      id: 'security', color: 'amber', title: 'Revisar seguridad', sub: 'Vulnerabilidades', needsRepo: true,
      icon: '<path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>',
      prompt: 'Haz una revisión de seguridad completa. Para cada problema: archivo, linea, riesgo y el código exacto de la corrección.',
    },
    {
      id: 'perf', color: 'purple', title: 'Rendimiento', sub: 'Optimizar velocidad', needsRepo: true,
      icon: '<path d="M7 2v11h3v9l7-12h-4l4-8z"/>',
      prompt: 'Optimiza el rendimiento: lazy loading, N+1 queries, bundle size, caching, async/await mal usado. Muestra el codigo optimizado.',
    },
  ],
};

// Las tarjetas de código exigen un repositorio conectado: sin él,
// el prompt iría al vacío. Tocarla sin repo abre la conexión.
function doRepoQuick(prompt) {
  if (!S.repoData) {
    showToast('Primero conecta un repositorio');
    openModal();
    return;
  }
  doQuick(prompt);
}

// Estas dos no son "prompts para la IA", son acciones directas
// de la app, asi que quedan separadas del set de arriba.
const SESSION_TASKS = [
  {
    id: 'export', color: 'green', title: 'Exportar conversacion', sub: 'Descargar como Markdown',
    icon: '<path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>',
    action: () => exportConversation(),
  },
  {
    id: 'newchat', color: 'red', title: 'Nueva conversacion', sub: 'Limpiar chat y empezar de cero',
    icon: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
    action: () => { clearChat(); showScreen('chat'); },
  },
  {
    id: 'agentsmd', color: 'blue', title: 'Reglas del proyecto', sub: 'Cómo debe trabajar en este proyecto',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
    action: () => doCreateAgentsMd(),
  },
  {
    id: 'diff', color: 'purple', title: 'Ver cambios', sub: 'Cambios sin subir',
    icon: '<rect x="4" y="3" width="7" height="18" rx="1.5"/><rect x="13" y="3" width="7" height="18" rx="1.5"/>',
    action: () => openDiffModal(),
  },
  {
    id: 'undo', color: 'amber', title: 'Volver al estado anterior', sub: 'Recupera el último estado guardado',
    icon: '<path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>',
    action: () => doUndo(),
  },
];

function renderQuickCards() {
  // El prompt va como argumento JSON dentro del onclick: el atributo
  // usa comillas SIMPLES (el JSON lleva dobles) y los apóstrofos del
  // texto van como &#39; (el HTML los decodifica antes de que JS lo
  // lea). Con comillas dobles el atributo se truncaba y las 14
  // tarjetas quedaban muertas (v10 BUG 1).
  const mount = (containerId, list, fn = 'doQuick') => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = list.map((t) => {
      const needsRepo = t.needsRepo && !S.repoData;
      const clickFn = t.needsRepo ? 'doRepoQuick' : fn;
      const promptArg = JSON.stringify(t.prompt).replace(/'/g, '&#39;');
      return `
      <button class="qcard${needsRepo ? ' qcard-needs-repo' : ''}" onclick='${clickFn}(${promptArg})'>
        <div class="qcard-icon ${t.color}"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" style="color:#fff">${t.icon}</svg></div>
        <div class="qcard-title">${esc(t.title)}</div>
        <div class="qcard-sub">${esc(t.sub)}${needsRepo ? ' · necesita un repositorio' : ''}</div>
      </button>`;
    }).join('');
  };
  mount('quick-grid-create', QUICK_TASKS.create, 'doQuickPrefill');
  mount('quick-grid-investigate', QUICK_TASKS.investigate, 'doQuickPrefill');
  mount('quick-grid-code', QUICK_TASKS.code);
}

function renderTaskScreen() {
  // Trabajos en curso (H2): se refrescan en segundo plano.
  refreshJobsSection();
  const quickList = [...QUICK_TASKS.create];
  const quickEl = document.getElementById('task-list-quick');
  if (quickEl) {
    quickEl.innerHTML = quickList.map((t) => `
      <div class="task-card" onclick='doQuick(${JSON.stringify(t.prompt)});showScreen("chat")'>
        <div class="task-icon" style="background:var(--${t.color})">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="20" height="20" style="color:#fff">${t.icon}</svg>
        </div>
        <div class="task-info">
          <div class="task-name">${esc(t.title)}</div>
          <div class="task-desc">${esc(t.sub)}</div>
        </div>
        <svg class="task-arrow" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
      </div>
    `).join('');
  }

  const toolsEl = document.getElementById('task-list-tools');
  if (toolsEl) {
    // Mismo cuidado que renderQuickCards: atributo con comillas
    // simples y apóstrofos como &#39;; las tarjetas de código
    // exigen repo (doRepoQuick) y se atenúan sin él.
    toolsEl.innerHTML = [...QUICK_TASKS.investigate, ...QUICK_TASKS.code].map((t) => {
      const promptArg = JSON.stringify(t.prompt).replace(/'/g, '&#39;');
      const needsRepo = t.needsRepo && !S.repoData;
      const click = t.needsRepo
        ? `doRepoQuick(${promptArg})`
        : (t.prompt.endsWith(': ') ? `doQuickPrefill(${promptArg})` : `doQuick(${promptArg});showScreen("chat")`);
      return `
      <div class="task-card${needsRepo ? ' task-card-needs-repo' : ''}" onclick='${click}'>
        <div class="task-icon" style="background:var(--${t.color})">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="20" height="20" style="color:#fff">${t.icon}</svg>
        </div>
        <div class="task-info">
          <div class="task-name">${esc(t.title)}</div>
          <div class="task-desc">${esc(t.sub)}${needsRepo ? ' · necesita un repositorio' : ''}</div>
        </div>
        <svg class="task-arrow" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
      </div>`;
    }).join('');
  }

  const sessionEl = document.getElementById('task-list-session');
  if (sessionEl) {
    sessionEl.innerHTML = SESSION_TASKS.map((t, i) => `
      <div class="task-card" onclick="SESSION_TASKS[${i}].action()">
        <div class="task-icon" style="background:var(--${t.color})">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="20" height="20" style="color:#fff">${t.icon}</svg>
        </div>
        <div class="task-info">
          <div class="task-name">${esc(t.title)}</div>
          <div class="task-desc">${esc(t.sub)}</div>
        </div>
        <svg class="task-arrow" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
      </div>
    `).join('');
  }
}

// ═══════════════════════════════════════════
// SCREEN NAVIGATION
// ═══════════════════════════════════════════
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.side-nav').forEach(n => n.classList.toggle('active', n.dataset.screen === name));
  // En móvil, navegar cierra el drawer de la sidebar.
  document.body.classList.remove('side-open');
  const screen = document.getElementById('screen-' + name);
  const nav = document.getElementById('nav-' + name);
  if (screen) screen.classList.add('active');
  if (nav) nav.classList.add('active');
  S.currentScreen = name;

  if (name === 'settings') syncSettingsUI();
  if (name === 'files') renderFileList();
  if (name === 'tasks') renderTaskScreen();
  if (name === 'chats') { renderChatsList(); loadThreads(); }
  // v8: en móvil el chat arranca oculto (inicio = lista); al entrar,
  // el textarea necesita su altura real (autoGrow con scrollHeight 0
  // lo dejaba en 0px y el placeholder se veía recortado).
  if (name === 'chat') autoGrow();
}

// ═══════════════════════════════════════════
// BARO v10 — lista de conversaciones reales (FASE 3)
// Las conversaciones viven en el servidor (por usuario): la lista
// muestra título, preview y hora reales, no un preview inventado
// del DOM. Cada fila se abre; el lápiz renombra en línea y la
// papelera borra en dos toques. La fila de la conversación con un
// trabajo en curso muestra "Trabajando…".
// ═══════════════════════════════════════════
function formatThreadTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

async function loadThreads() {
  let list = null;
  try {
    const resp = await authorizedApiFetch(`${API}/threads`);
    if (resp.ok) list = (await resp.json()).threads;
  } catch { /* sin sesión, la lista queda como estaba */ }
  if (!Array.isArray(list)) return;
  S.threads = list;
  renderChatsList();
}

function renderChatsList() {
  const container = document.getElementById('chats-list');
  if (!container) return;
  const activeByThread = {};
  for (const job of S.activeJobs || []) {
    if (job.threadId) activeByThread[job.threadId] = true;
  }
  const markSvg = '<svg class="logo-svg" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false"><use href="#baro-mark"/></svg>';
  if (!S.threads.length) {
    container.innerHTML = `
      <button class="chat-row" id="chats-row-baro" onclick="showScreen('chat')">
        <span class="chat-row-mark">${markSvg}</span>
        <span class="chat-row-txt">
          <span class="chat-row-top"><span class="chat-row-name">Baro</span><span class="chat-row-time" id="chats-row-time"></span></span>
          <span class="chat-row-preview" id="chats-row-preview">Sin mensajes aún</span>
        </span>
      </button>`;
    return;
  }
  container.innerHTML = S.threads.map((t) => {
    const working = !!activeByThread[t.id];
    const active = t.id === S.currentThreadId;
    return `
    <div class="chat-row${active ? ' chat-row-active' : ''}" data-thread="${esc(t.id)}">
      <button class="chat-row-main" onclick="openThread('${esc(t.id)}')">
        <span class="chat-row-mark">${markSvg}</span>
        <span class="chat-row-txt">
          <span class="chat-row-top"><span class="chat-row-name">${esc(t.title)}</span><span class="chat-row-time">${esc(formatThreadTime(t.updatedAt))}</span></span>
          <span class="chat-row-preview">${working ? 'Trabajando…' : esc(t.preview || 'Sin mensajes aún')}</span>
        </span>
      </button>
      <span class="chat-row-tools">
        <button class="chat-row-tool" onclick="renameThreadInline('${esc(t.id)}', this)" aria-label="Cambiar nombre"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>
        <button class="chat-row-tool" onclick="deleteThread('${esc(t.id)}', this)" aria-label="Borrar conversación"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
      </span>
    </div>`;
  }).join('');
}

// Abre una conversación: pinta sus mensajes guardados y el
// siguiente mensaje sigue en el mismo hilo.
async function openThread(id, opts = {}) {
  if (S.busy && !opts.force) { showToast('El agente esta trabajando...'); return; }
  let thread = null;
  try {
    const resp = await authorizedApiFetch(`${API}/threads/${encodeURIComponent(id)}`);
    if (resp.ok) thread = (await resp.json()).thread;
  } catch {}
  if (!thread) { showToast('No se pudo abrir la conversación'); return; }
  S.currentThreadId = thread.id;
  const msgs = document.getElementById('msgs');
  msgs.innerHTML = '';
  document.getElementById('empty').classList.add('gone');
  showActivity(false);
  resetComputerView();
  hidePushBanner();
  S.pendingEdits = [];
  updateTasksBadge();
  clearActivityLog();
  resetPlanPanel();
  _restoringChat = true;
  for (const m of thread.messages || []) {
    if (!m || !m.text) continue;
    const div = addMsg(m.role === 'me' ? 'me' : 'ai', m.text);
    const bodyEl = div.querySelector('.mbody');
    if (bodyEl) bodyEl.innerHTML = `<p style="white-space:pre-wrap">${esc(m.text)}</p>`;
    const timeEl = div.querySelector('.mtime');
    if (timeEl && m.time) timeEl.textContent = m.time;
    div.querySelector('.msg-actions')?.remove();
  }
  _restoringChat = false;
  document.getElementById('context-bar')?.classList.remove('show');
  try { localStorage.removeItem(chatStoreKey()); } catch {}
  renderChatsList();
  showScreen('chat');
  scrollChatToBottom(false);
}

// Renombra en línea: el título se vuelve un campo editable
// (Enter guarda, Escape cancela, al salir guarda).
function renameThreadInline(id, btn) {
  const row = btn.closest('.chat-row');
  const nameEl = row?.querySelector('.chat-row-name');
  if (!nameEl || nameEl.querySelector('input')) return;
  const current = nameEl.textContent;
  const input = document.createElement('input');
  input.className = 'chat-row-rename';
  input.value = current;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Nombre de la conversación');
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (save && title && title !== current) {
      try {
        const resp = await authorizedApiFetch(`${API}/threads/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        if (resp.ok) { await loadThreads(); return; }
      } catch {}
      showToast('No se pudo cambiar el nombre');
    }
    nameEl.textContent = current;
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

// Borra en dos toques: el primero arma ("¿Borrar?"), el segundo
// borra de verdad. Sin diálogos del sistema.
async function deleteThread(id, btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.classList.add('armed');
    btn.title = 'Toca otra vez para borrar';
    setTimeout(() => { btn.removeAttribute('data-armed'); btn.classList.remove('armed'); }, 3000);
    return;
  }
  btn.removeAttribute('data-armed');
  btn.classList.remove('armed');
  try {
    const resp = await authorizedApiFetch(`${API}/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error();
    if (S.currentThreadId === id) {
      S.currentThreadId = null;
      document.getElementById('msgs').innerHTML = '';
      document.getElementById('empty').classList.remove('gone');
    }
    await loadThreads();
    showToast('Conversación borrada');
  } catch {
    showToast('No se pudo borrar la conversación');
  }
}

// Nombre/iniciales del usuario para el avatar (Firebase o invitado).
function userDisplayName() {
  const u = window.FB?.currentUser;
  if (u?.displayName) return u.displayName;
  if (u?.email) return u.email.split('@')[0];
  return 'Usuario de Baro';
}
function userInitials() {
  const name = userDisplayName().replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]/g, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || 'B').toUpperCase();
}
function syncUserAvatar() {
  const ini = userInitials();
  const av = document.getElementById('chats-avatar');
  if (av) av.textContent = ini;
  const sav = document.getElementById('settings-avatar');
  if (sav) sav.textContent = ini;
  const nm = document.getElementById('settings-profile-name');
  if (nm) nm.textContent = userDisplayName();
  const sub = document.getElementById('settings-profile-sub');
  if (sub) sub.textContent = window.FB?.currentUser?.email || 'Sesión local';
}
function showProfileInfo() {
  const email = window.FB?.currentUser?.email;
  showToast(email ? `Sesión: ${email}` : 'Sesión local sin cuenta');
}
// Baro es solo texto por diseño (v6): el micrófono del composer
// no graba ni dicta; solo lo explica. No reintroducir audio.
function voiceUnavailable() {
  showToast('Baro es solo texto: escribe tu tarea');
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
function loadSettings() {
  S.ghToken = localStorage.getItem('da_gh_token') || '';
  S.multiAgentEnabled = localStorage.getItem('da_multi_agent') !== 'false';
  S.planModeEnabled = localStorage.getItem('da_plan_mode') === 'true';
  S.fileLimit = parseInt(localStorage.getItem('da_file_limit') || '10');
  if (![50, 100, 200].includes(S.fileLimit)) S.fileLimit = 100;
  S.applyMode = localStorage.getItem('da_apply_mode') === 'ask' ? 'ask' : 'auto';
  updateStatusBadges();
}

function syncSettingsUI() {
  syncUserAvatar();
  const maToggle = document.getElementById('multiagent-toggle');
  if (maToggle) { maToggle.classList.toggle('on', S.multiAgentEnabled); maToggle.setAttribute('aria-checked', String(S.multiAgentEnabled)); }

  const pmToggle = document.getElementById('planmode-toggle');
  if (pmToggle) { pmToggle.classList.toggle('on', S.planModeEnabled); pmToggle.setAttribute('aria-checked', String(S.planModeEnabled)); }

  const segAuto = document.getElementById('seg-auto');
  const segAsk = document.getElementById('seg-ask');
  if (segAuto) segAuto.classList.toggle('on', S.applyMode !== 'ask');
  if (segAsk) segAsk.classList.toggle('on', S.applyMode === 'ask');

  const fl = document.getElementById('filelimit-select');
  if (fl) fl.value = String(S.fileLimit);
}

// Refleja S.pendingEdits (archivos con diffs REALMENTE aplicados
// en disco, ver applyDiff) como numero en el icono de Tareas, para
// que el usuario vea de un vistazo si hay trabajo listo para subir.
function updateTasksBadge() {
  const badge = document.getElementById('tasks-nav-badge');
  if (!badge) return;
  const n = S.pendingEdits.length;
  badge.textContent = n > 9 ? '9+' : String(n);
  badge.style.display = n > 0 ? '' : 'none';
  // La sidebar de escritorio refleja el mismo contador.
  const sideBadge = document.getElementById('tasks-side-badge');
  if (sideBadge) { sideBadge.textContent = badge.textContent; sideBadge.style.display = badge.style.display; }
}

function toggleSetting(name) {
  if (name === 'multiagent') {
    S.multiAgentEnabled = !S.multiAgentEnabled;
    const tog = document.getElementById('multiagent-toggle');
    if (tog) { tog.classList.toggle('on', S.multiAgentEnabled); tog.setAttribute('aria-checked', String(S.multiAgentEnabled)); }
  } else if (name === 'planmode') {
    S.planModeEnabled = !S.planModeEnabled;
    const tog = document.getElementById('planmode-toggle');
    if (tog) { tog.classList.toggle('on', S.planModeEnabled); tog.setAttribute('aria-checked', String(S.planModeEnabled)); }
  }
}

function saveSettings() {
  localStorage.setItem('da_multi_agent', S.multiAgentEnabled ? 'true' : 'false');
  localStorage.setItem('da_plan_mode', S.planModeEnabled ? 'true' : 'false');
  localStorage.setItem('da_file_limit', String(S.fileLimit));
  localStorage.setItem('da_apply_mode', S.applyMode);

  // Persistir en Firebase para que se carguen en cualquier dispositivo
  if (window.FB?.currentUser) {
    FB.saveUserData({
      ghToken: S.ghToken,
      multiAgentEnabled: S.multiAgentEnabled,
      planModeEnabled: S.planModeEnabled,
    });
  }

  updateStatusBadges();
  showToast('Configuracion guardada ✓');
  showScreen('chat');
}

function openFeedbackModal() {
  const modal = document.getElementById('feedback-modal');
  if (!modal) return;
  document.getElementById('feedback-title').value = '';
  document.getElementById('feedback-description').value = '';
  document.getElementById('feedback-steps').value = '';
  document.getElementById('feedback-severity').value = 'medium';
  document.getElementById('feedback-result').style.display = 'none';
  document.getElementById('feedback-submit').disabled = false;
  document.getElementById('feedback-submit').textContent = 'Enviar reporte';
  modal.classList.add('open');
}

function closeFeedbackModal() {
  document.getElementById('feedback-modal')?.classList.remove('open');
}

async function submitFeedback() {
  const title = document.getElementById('feedback-title')?.value.trim();
  const description = document.getElementById('feedback-description')?.value.trim();
  const steps = document.getElementById('feedback-steps')?.value.trim();
  const severity = document.getElementById('feedback-severity')?.value || 'medium';
  const result = document.getElementById('feedback-result');
  const button = document.getElementById('feedback-submit');

  if (!title || !description) {
    result.textContent = 'Completa el título y la descripción del problema.';
    result.className = 'feedback-result error';
    result.style.display = '';
    return;
  }

  button.disabled = true;
  button.textContent = 'Enviando...';
  try {
    const response = await apiFetch(`${API}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        steps,
        severity,
        sessionId: S.sessionId,
        page: S.currentScreen,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
    result.textContent = `Reporte enviado. ID: ${data.id}`;
    result.className = 'feedback-result success';
    result.style.display = '';
    button.textContent = 'Enviado';
    setTimeout(closeFeedbackModal, 1600);
  } catch (error) {
    result.textContent = error.message;
    result.className = 'feedback-result error';
    result.style.display = '';
    button.disabled = false;
    button.textContent = 'Reintentar';
  }
}

// Intentos de initSession: distinguen "aún no se ha intentado"
// (Comprobando…) de "se intentó y no hay conexión" (Sin conexión).
// Sin esto los badges se quedaban en "Comprobando…" para siempre
// (v10 BUG 3). _initToastShown evita el spam de avisos.
// OJO: sin Firebase el inicio de sesión ni siquiera existe como
// intento (initSession nunca corre), así que `tried` también cubre
// window._fbLoadFailed, que pone firebase-auth.js cuando el CDN no
// cargó; si no, el badge volvía a quedarse en "Comprobando…"
// para siempre en el navegador real.
let _initAttempts = 0;
let _initToastShown = false;

function updateStatusBadges() {
  const el = (id) => document.getElementById(id);
  const serverUp = !!S.serverConfig;
  const tried = _initAttempts > 0 || window._fbLoadFailed === true;
  const ollamaOk = !!S.serverConfig?.ollamaReady;
  // La inteligencia trabaja aunque la IA local no esté (el agente
  // usa sus proveedores en la nube): si el servidor respondió, el
  // estado es Listo. Solo sin servidor hay "Sin conexión".
  const aiState = serverUp ? 'Listo para trabajar' : (tried ? 'Sin conexión' : 'Comprobando…');
  const aiShort = serverUp ? 'Listo' : (tried ? 'Sin conexión' : 'Comprobando…');

  el('ollama-ok-badge') && (el('ollama-ok-badge').style.display = ollamaOk ? '' : 'none');
  const warnBadge = el('ollama-warn-badge');
  if (warnBadge) {
    warnBadge.style.display = ollamaOk ? 'none' : '';
    warnBadge.textContent = !serverUp
      ? (tried ? 'Sin conexión' : 'Iniciando')
      : 'No disponible';
  }
  // En pantalla nunca se muestran nombres de proveedor ni de modelo:
  // solo el estado (Listo / Comprobando…). Los datos reales siguen en
  // S.serverConfig para uso interno.
  el('ollama-settings-sub') && (el('ollama-settings-sub').textContent = serverUp
    ? (ollamaOk ? 'Listo' : 'No disponible')
    : (tried ? 'Sin conexión' : 'Comprobando…'));
  el('ai-model-label') && (el('ai-model-label').textContent = 'Inteligencia');
  el('ai-model-sub') && (el('ai-model-sub').textContent = aiState);

  const ghOk = !!S.repoData;
  el('gh-settings-badge') && (el('gh-settings-badge').style.display = ghOk ? 'none' : '');
  el('gh-settings-badge-ok') && (el('gh-settings-badge-ok').style.display = ghOk ? '' : 'none');
  el('gh-settings-sub') && (el('gh-settings-sub').textContent = ghOk ? S.repoData.full_name : 'Conecta un repositorio');
  const modelBadge = el('ai-model-badge');
  if (modelBadge) modelBadge.textContent = aiShort;
  // Sidebar v7: mismo estado del repo y de la inteligencia, siempre visible.
  el('side-repo-name') && (el('side-repo-name').textContent = ghOk ? S.repoData.full_name : 'Sin repositorio');
  el('side-repo-sub') && (el('side-repo-sub').textContent = ghOk
    ? (S.branch ? `Rama ${S.branch} · conectado` : 'Conectado a GitHub')
    : 'Conecta un repo para trabajar sobre código real');
  el('side-model') && (el('side-model').textContent = aiState);
  syncStatusBar();
}

// ═══════════════════════════════════════════
// GITHUB MODAL
// ═══════════════════════════════════════════
let modalStep = 1;

function openModal() {
  modalStep = 1;
  renderStep();
  document.getElementById('modal').classList.add('open');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }

function renderStep() {
  const c = document.getElementById('step-content');
  document.getElementById('modal-back').style.display = modalStep > 1 ? '' : 'none';
  document.getElementById('modal-next').textContent = modalStep === 3 ? 'Empezar' : 'Continuar';
  document.getElementById('modal-title').textContent = ['Conectar repo','Configurar','Listo'][modalStep-1];

  ['stp1','stp2','stp3'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = 'stp';
    if (i+1 < modalStep) el.classList.add('done');
    else if (i+1 === modalStep) el.classList.add('active');
  });

  if (modalStep === 1) {
    // Restaurar steps si venimos de repo picker
    const stepsEl = document.getElementById('modal-steps');
    if (stepsEl) stepsEl.style.display = '';
    const titleEl = document.getElementById('modal-title');
    if (titleEl) titleEl.textContent = 'Conectar repo';

    c.innerHTML = `
      <div style="text-align:center;padding:8px 0 16px">
        <button class="gh-oauth-btn" onclick="startDeviceFlow()" style="width:100%;justify-content:center">
          <svg viewBox="0 0 16 16" fill="currentColor" width="18" height="18"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          Conectar con GitHub
        </button>
        <div style="font-size:12px;color:var(--text3);margin-top:12px">Autoriza en tu navegador — sin contraseñas</div>
      </div>`;
  } else if (modalStep === 2) {
    c.innerHTML = `
      <div class="fg" style="margin-bottom:16px">
        <label class="fl">Instrucciones personalizadas <span style="color:var(--text3);font-size:10px">opcional</span></label>
        <textarea class="fi" id="repo-inst" rows="3" style="resize:none" placeholder="Ej: El proyecto usa TypeScript. Los componentes van en src/components/">${S.instructions}</textarea>
        <div class="fh">El agente usara estas instrucciones en toda la sesion.</div>
      </div>
      <div id="modal-info" style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:14px;font-size:13px;color:var(--text2)">
        Cargando informacion...
      </div>`;
    loadRepoInfo();
  } else {
    const r = S.repoData;
    c.innerHTML = `
      <div style="text-align:center;padding:16px 0">
        <div style="width:56px;height:56px;border-radius:16px;background:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 8px 24px rgba(217,119,87,.3)">
          <svg width="26" height="26" viewBox="0 0 16 16" fill="white"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
        </div>
        <div style="font-size:17px;font-weight:800;margin-bottom:5px;letter-spacing:-.3px">${r ? r.full_name : 'Repositorio'}</div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:16px">${r ? (r.description || 'Sin descripcion') : ''}</div>
        <div style="display:flex;justify-content:center;gap:20px;font-size:12.5px">
          <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:var(--accent)">${S.files.length}</div><div style="color:var(--text3)">archivos</div></div>
          <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:var(--green)">${r ? (r.language || 'multi') : ''}</div><div style="color:var(--text3)">lenguaje</div></div>
          <div style="text-align:center"><div style="font-size:20px;font-weight:800;color:var(--text2)">${S.branch}</div><div style="color:var(--text3)">rama</div></div>
        </div>
      </div>`;
  }
}

async function loadRepoInfo() {
  const url = (S._pendingRepo ? 'https://github.com/'+S._pendingRepo : '') || (S.repoData ? 'https://github.com/'+S.repoData.full_name : '');
  const info = document.getElementById('modal-info');
  if (!url || !info) return;
  try {
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!match) throw new Error('URL invalida');
    const repo = match[1].replace(/\.git$/, '');
    // Vista previa liviana: metadata publica de GitHub, sin
    // tocar el backend todavia (el clon real ocurre recien al
    // confirmar "Conectar", para no clonar repos que el usuario
    // solo esta explorando).
    const headers = S.ghToken ? { 'Authorization': `token ${S.ghToken}` } : {};
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!r.ok) throw new Error(`Error ${r.status}`);
    const data = await r.json();
    info.innerHTML = `<div style="font-weight:700;color:var(--text);margin-bottom:6px;font-size:14px">${esc(data.full_name)}</div>
      <div style="color:var(--text2);margin-bottom:10px">${esc(data.description || 'Sin descripcion')}</div>
      <div style="display:flex;gap:16px;font-size:11.5px;flex-wrap:wrap">
        <span style="color:var(--text3)">Lang: <strong style="color:var(--text2)">${esc(data.language || 'varios')}</strong></span>
        <span style="color:var(--text3)">⭐ <strong style="color:var(--text2)">${data.stargazers_count}</strong></span>
        <span style="color:var(--text3)">${data.private ? '🔒 Privado' : '🌐 Publico'}</span>
      </div>`;
  } catch(e) {
    info.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  }
}

async function modalNext() {
  if (modalStep === 1) {
    // Repo seleccionado via OAuth/device flow
    if (_selectedRepo) {
      modalStep = 2;
      _selectedRepo = null;
      renderStep();
      return;
    }
    showToast('Conecta con GitHub primero');
    return;
  } else if (modalStep === 2) {
    S.instructions = document.getElementById('repo-inst')?.value?.trim() || '';
    const btn = document.getElementById('modal-next');
    btn.textContent = 'Conectando...';
    btn.disabled = true;
    try {
      await connectRepo(S._pendingRepo);
      modalStep = 3;
      renderStep();
    } catch(e) {
      showToast('Error: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Continuar';
  } else {
    closeModal();
    showScreen('chat');
    autoAnalyze();
  }
}
function modalBack() { if (modalStep > 1) { modalStep--; renderStep(); } }

// ═══════════════════════════════════════════
// SESSION RECOVERY
// Si el servidor se reinició (Railway redeploy), la sesión en
// memoria desaparece. Esta función la detecta y la recrea sola.
// ═══════════════════════════════════════════
async function ensureSession() {
  if (!S.sessionId) await initSession();
}

function isSessionGone(data) {
  return typeof data.error === 'string' && data.error.toLowerCase().includes('sesi');
}

/** @param {string} url @param {RequestInit} [options] @returns {Promise<Response>} */
async function authorizedApiFetch(url, options = {}) {
  if (typeof window.FB?.getIdToken !== 'function') {
    throw new Error('La sesión de Firebase todavía no está lista.');
  }
  const firebaseToken = await window.FB.getIdToken();
  const agentToken = (() => { try { return localStorage.getItem('agent_token'); } catch { return null; } })();
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${firebaseToken}`,
      ...(agentToken ? { 'x-agent-token': agentToken } : {}),
    },
  });
}

/** @param {string} url @param {RequestInit} [options] @param {boolean} [retry] @returns {Promise<Response>} */
async function apiFetch(url, options = {}, retry = true) {
  await ensureSession();
  const requestUrl = typeof url === 'string'
    ? url.replace(/([?&]sessionId=)[^&]*/, `$1${encodeURIComponent(S.sessionId)}`)
    : url;
  const body = typeof options.body === 'string'
    ? options.body.replace(/"sessionId":"[^"]*"/, `"sessionId":"${S.sessionId}"`)
    : options.body;
  const resp = await authorizedApiFetch(requestUrl, {
    ...options,
    body,
  });
  if (resp.status === 404 && retry) {
    const data = await resp.clone().json().catch(() => ({}));
    if (isSessionGone(data)) {
      S.sessionId = null;
      await initSession();
      return apiFetch(url, options, false);
    }
  }
  return resp;
}

// ═══════════════════════════════════════════
// REPO REAL (via backend — clon en disco, no simulado)
// ═══════════════════════════════════════════
async function connectRepo(repo) {
  await ensureSession();

  const makeBody = () => JSON.stringify({
    sessionId: S.sessionId,
    url: `https://github.com/${repo}`,
    branch: S.branch,
    token: S.ghToken || undefined,
    instructions: S.instructions || '',
  });

  let resp = await apiFetch(`${API}/repo/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: makeBody(),
  });

  // Si la sesión expiró (Railway reinició), crearla y reintentar una vez
  if (resp.status === 404) {
    const d = await resp.json().catch(() => ({}));
    if (isSessionGone(d)) {
      S.sessionId = null;
      await initSession();
      resp = await apiFetch(`${API}/repo/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: makeBody(),
      });
    }
  }

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || `Error ${resp.status} conectando el repositorio`);

  // El backend devuelve la metadata real de GitHub y la lista
  // real de archivos leida del clon que acaba de hacer en disco.
  S.repoData = {
    full_name: data.repo.fullName,
    description: data.repo.description,
    language: data.repo.language,
    stargazers_count: data.repo.stars,
    private: data.repo.private,
    default_branch: data.repo.branch,
  };
  S.files = data.files.map((path) => ({ path }));
  S.branch = data.repo.branch;
  S.ok = true;

  const dot = document.getElementById('conn-dot');
  if (dot) dot.classList.add('ok');
  const tbSub = document.getElementById('tb-sub');
  if (tbSub) tbSub.textContent = S.repoData.full_name.split('/').pop() + ' · ' + S.files.length + ' archivos';

  const ghIbtnTxt = document.getElementById('gh-ibtn-txt');
  if (ghIbtnTxt) ghIbtnTxt.textContent = S.repoData.full_name.split('/').pop();
  const ghIbtn = document.getElementById('gh-ibtn');
  if (ghIbtn) ghIbtn.classList.add('gok');

  const fileRefBtn = document.getElementById('file-ref-btn');
  if (fileRefBtn) fileRefBtn.style.display = '';

  updateStatusBadges();
  renderFileList();
  // Las tarjetas que exigen repo cambian de estado al conectar.
  renderQuickCards();

  // Guardar ultimo repo en Firebase para auto-reconexion
  if (window.FB?.currentUser) {
    FB.saveLastRepo({ fullName: repo, branch: S.branch, instructions: S.instructions || '' });
  }
}

async function fetchFile(path) {
  S._lastFileError = '';
  if (!S.repoData || !S.sessionId) { S._lastFileError = 'sin repositorio conectado'; return null; }
  try {
    const r = await apiFetch(`${API}/repo/file?sessionId=${encodeURIComponent(S.sessionId)}&path=${encodeURIComponent(path)}`);
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      S._lastFileError = d.error || `Error ${r.status}`;
      return null;
    }
    const data = await r.json();
    return data.content;
  } catch (e) { S._lastFileError = e.message; return null; }
}

// ═══════════════════════════════════════════
// FILE LIST RENDER
// ═══════════════════════════════════════════
const EXT_COLORS = {
  js:'#f7df1e', ts:'#3178c6', jsx:'#61dafb', tsx:'#61dafb',
  py:'#3572a5', go:'#00add8', rs:'#dea584', rb:'#cc342d',
  java:'#b07219', kt:'#f18e33', swift:'#fa7343', cs:'#178600',
  css:'#563d7c', scss:'#c6538c', html:'#e34c26', vue:'#41b883',
  json:'#292929', md:'#083fa1', yml:'#cb171e', yaml:'#cb171e',
  sh:'#89e051', bash:'#89e051', env:'#777', sql:'#e38c00',
  php:'#4f5d95', cpp:'#f34b7d', c:'#555', h:'#555',
};

function getExtColor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return EXT_COLORS[ext] || '#4A4E6A';
}

function renderFileList() {
  const wrap = document.getElementById('file-list');
  const noRepo = document.getElementById('no-repo-msg');
  if (!wrap) return;

  if (!S.repoData || !S.files.length) {
    wrap.innerHTML = '';
    if (noRepo) noRepo.style.display = '';
    return;
  }
  if (noRepo) noRepo.style.display = 'none';

  const title = document.getElementById('files-title');
  if (title) title.textContent = S.repoData.full_name.split('/').pop() + ' — ' + S.files.length + ' archivos';

  const grouped = {};
  S.files.forEach(f => {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, parts.length-1).join('/') : '/';
    if (!grouped[dir]) grouped[dir] = [];
    grouped[dir].push(f);
  });

  let html = '';
  for (const [dir, files] of Object.entries(grouped)) {
    html += `<div class="fb-dir-group" data-dir="${esc(dir)}">
      <div class="file-dir-header">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3h-6.5L5.987 1.755A1.75 1.75 0 004.744 1H1.75z"/></svg>
        ${esc(dir)}
      </div>`;
    files.forEach(f => {
      const name = f.path.split('/').pop();
      html += `<div class="file-row fb-file" data-path="${esc(f.path)}" onclick="openFileViewer('${esc(f.path)}')">
        <div class="file-ext-dot" style="background:${getExtColor(f.path)}"></div>
        <span class="file-name">${esc(name)}</span>
        <button class="file-action-btn" onclick="event.stopPropagation();askAboutFile('${esc(f.path)}')">Analizar</button>
      </div>`;
    });
    html += `</div>`;
  }
  wrap.innerHTML = html;
}

function filterFiles(q) {
  const lower = q.toLowerCase();
  document.querySelectorAll('#file-list .fb-file').forEach(el => {
    const path = el.getAttribute('data-path') || '';
    el.style.display = path.toLowerCase().includes(lower) ? '' : 'none';
  });
  document.querySelectorAll('#file-list .fb-dir-group').forEach(el => {
    const visible = [...el.querySelectorAll('.fb-file')].some(f => f.style.display !== 'none');
    el.style.display = visible ? '' : 'none';
  });
}

// ═══════════════════════════════════════════
// FILE VIEWER
// ═══════════════════════════════════════════
async function openFileViewer(path) {
  S.currentFile = path;
  const viewer = document.getElementById('file-viewer');
  const name = path.split('/').pop();

  document.getElementById('fv-name').textContent = name;
  document.getElementById('fv-path').textContent = path;
  document.getElementById('fv-code').innerHTML = '<div class="fv-loading"><div class="dots"><span></span><span></span><span></span></div></div>';
  viewer.classList.add('open');

  const content = await fetchFile(path);
  if (content === null || content === undefined) {
    const why = S._lastFileError ? ': ' + esc(S._lastFileError) : '';
    document.getElementById('fv-code').innerHTML = `<div class="fv-loading">No se pudo cargar el archivo${why}</div>`;
    if (S._lastFileError) showToast('Error cargando el archivo: ' + S._lastFileError);
    return;
  }

  const lines = content.split('\n');
  const escaped = lines.map((line, i) =>
    `<span class="line-num">${i+1}</span>${esc(line)}`
  ).join('\n');

  document.getElementById('fv-code').innerHTML = `<pre>${escaped}</pre>`;
}

function closeFileViewer() {
  document.getElementById('file-viewer').classList.remove('open');
}

function analyzeCurrentFile() {
  if (!S.currentFile) return;
  closeFileViewer();
  showScreen('chat');
  doQuick(`Analiza el archivo \`${S.currentFile}\` en detalle: que hace, patrones usados, bugs potenciales, problemas de calidad, y si encuentras algo muestra el cambio exacto sugerido.`);
}

function editCurrentFile() {
  if (!S.currentFile) return;
  closeFileViewer();
  showScreen('chat');
  const inp = document.getElementById('inp');
  inp.value = `Mejora el archivo \`${S.currentFile}\`: `;
  inp.focus();
  inp.style.height = 'auto';
  inp.style.height = inp.scrollHeight + 'px';
  document.getElementById('sndbtn').disabled = !inp.value.trim();
}

function askAboutFile(path) {
  showScreen('chat');
  doQuick(`Analiza el archivo \`${path}\`: que hace, patrones usados, bugs potenciales y si encuentras algo muestra el cambio exacto.`);
}

// ═══════════════════════════════════════════
// PUSH
// ═══════════════════════════════════════════
function hidePushBanner() { document.getElementById('push-banner').classList.remove('show'); }
function doPush() { hidePushBanner(); openPushModal(); }

function showPushBanner(files) {
  if ((!S.ghToken && !S.serverConfig?.githubPreconfigured) || !S.repoData) return;
  document.getElementById('push-banner-detail').textContent = files.length === 1 ? `1 archivo: ${files[0]}` : `${files.length} archivos listos`;
  document.getElementById('push-banner').classList.add('show');
}

function openPushModal() {
  document.getElementById('push-commit-msg').value = `Cambios con Baro ${new Date().toISOString().slice(0,10)}`;
  document.getElementById('push-branch').value = S.branch;
  document.getElementById('push-result').style.display = 'none';
  document.getElementById('push-confirm-btn').disabled = false;
  document.getElementById('push-confirm-btn').textContent = 'Subir';

  const list = document.getElementById('push-files-list');
  if (S.pendingEdits.length) {
    list.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px">${S.pendingEdits.length} archivos con cambios</div>` +
      S.pendingEdits.map(e => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0"></div>
        <span style="font-family:var(--mono);color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.path)}</span>
      </div>`).join('');
  } else {
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:8px 0;line-height:1.6">Aun no hay cambios aplicados. Toca "Aplicar" en un bloque de cambios del chat para escribirlo de verdad en el archivo, y aparecera aqui.</div>`;
  }
  document.getElementById('push-modal').classList.add('open');
}
function closePushModal() { document.getElementById('push-modal').classList.remove('open'); }

async function confirmPush() {
  if (!S.sessionId) { showToast('Sesion no lista, intenta de nuevo'); return; }
  if (!S.ghToken && !S.serverConfig?.githubPreconfigured) { showToast('Conecta tu cuenta de GitHub primero'); return; }
  if (!S.repoData) { showToast('No hay repo conectado'); return; }

  const msg = document.getElementById('push-commit-msg').value.trim() || 'Cambios con Baro';
  const branch = document.getElementById('push-branch').value.trim() || S.branch;
  const btn = document.getElementById('push-confirm-btn');
  const result = document.getElementById('push-result');

  btn.disabled = true;
  btn.textContent = 'Subiendo...';

  try {
    // El commit+push real ocurre en el servidor sobre el clon
    // real en disco (el mismo donde ya se aplicaron los diffs
    // con applyDiff). Nunca se reconstruye contenido en el
    // navegador, asi que nunca puede subirse un archivo vacio.
    const resp = await apiFetch(`${API}/agent/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: S.sessionId,
        message: msg,
        branch,
        githubToken: S.ghToken || undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);

    result.style.display = '';
    if (!data.pushed) {
      result.innerHTML = `<div style="background:var(--ab);border:1px solid var(--gd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--amber)">${esc(data.reason || 'No habia cambios reales para subir')}</div>`;
      btn.disabled = false;
      btn.textContent = 'Subir';
      return;
    }

    result.innerHTML = `<div style="background:var(--gb);border:1px solid var(--gd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--green);font-weight:600">✓ ${data.files.length} archivo(s) subido(s) de verdad a GitHub</div>`;
    S.pendingEdits = [];
    updateTasksBadge();
    btn.textContent = 'Hecho';
    setTimeout(() => closePushModal(), 1800);
  } catch (e) {
    result.style.display = '';
    result.innerHTML = `<div style="background:var(--rb);border:1px solid var(--rd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--red)">${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Reintentar';
  }
}

// ── Abrir PR estilo Codex (H3) ───────────────────────────
// Abre el PR de la rama de tarea contra su base. Si no hay token,
// el servidor responde con el motivo honesto (code 'no-token') y
// aquí se muestra tal cual: nunca se finge que el PR existe.
async function openPullRequest() {
  if (!S.sessionId) { showToast('Sesion no lista, intenta de nuevo'); return; }
  if (!S.repoData) { showToast('No hay repo conectado'); return; }
  const result = document.getElementById('push-result');
  const btn = document.getElementById('push-pr-btn');
  const msg = document.getElementById('push-commit-msg').value.trim();
  result.style.display = '';
  btn.disabled = true;
  btn.textContent = 'Abriendo...';
  try {
    const resp = await apiFetch(`${API}/agent/pr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: S.sessionId,
        title: msg || undefined,
        githubToken: S.ghToken || undefined,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
    result.innerHTML = `<div style="background:var(--gb);border:1px solid var(--gd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--green);font-weight:600">${data.alreadyExists ? 'Revisión ya pedida' : 'Revisión pedida'}: <a href="${esc(data.url)}" target="_blank" rel="noopener" style="color:var(--green)">#${data.number} — ver en GitHub</a></div>`;
    btn.textContent = 'Pedir revisión';
    window.open(data.url, '_blank', 'noopener');
  } catch (e) {
    result.innerHTML = `<div style="background:var(--rb);border:1px solid var(--rd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--red)">${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'Pedir revisión';
  }
}

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════
function exportConversation() {
  const msgs = document.getElementById('msgs');
  if (!msgs?.children.length) { showToast('No hay mensajes para exportar'); return; }
  let md = `# Baro — Conversacion\n\n`;
  if (S.repoData) md += `**Repo:** ${S.repoData.full_name}\n`;
  md += `**Fecha:** ${new Date().toLocaleString('es')}\n\n---\n\n`;
  [...msgs.children].forEach(msg => {
    const isUser = msg.classList.contains('me');
    const body = msg.querySelector('.mbody');
    if (!body) return;
    md += `**${isUser ? 'Tu' : 'Baro'}:**\n\n${body.innerText}\n\n---\n\n`;
  });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([md], {type:'text/markdown'})),
    download: `devagent-${new Date().toISOString().slice(0,10)}.md`
  });
  a.click();
  showToast('Exportado como Markdown');
}

// ═══════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════
function setBusy(b) {
  const dot = document.getElementById('conn-dot');
  if (b) {
    dot?.classList.remove('ok');
    dot?.classList.add('busy');
    document.getElementById('sndbtn').style.display = 'none';
    document.getElementById('stopbtn').classList.add('show');
  } else {
    dot?.classList.remove('busy');
    if (S.ok) dot?.classList.add('ok');
    document.getElementById('sndbtn').style.display = '';
    document.getElementById('stopbtn').classList.remove('show');
  }
}

function showActivity(show, text='') {
  const el = document.getElementById('activity');
  if (show) {
    el.classList.add('show');
    el.classList.remove('done');
    const lg = document.getElementById('act-log');
    if (lg) lg.style.display = '';
    if (text) document.getElementById('act-head-txt').textContent = text;
    setBusy(true);
  } else {
    el.classList.remove('show');
    setBusy(false);
  }
}

// Al terminar el turno la evidencia QUEDA: el panel se colapsa
// (el log se repliega) pero sigue visible y se puede reabrir
// tocando su cabecera. Antes showActivity(false) lo borraba todo.
function finishActivity(label) {
  const el = document.getElementById('activity');
  if (el) {
    el.classList.add('show', 'done');
    const lg = document.getElementById('act-log');
    if (lg) lg.style.display = 'none';
    const head = document.getElementById('act-head-txt');
    if (head) head.textContent = label || 'Completado';
  }
  setBusy(false);
}

function toggleActivity() {
  const log = document.getElementById('act-log');
  if (log) log.style.display = log.style.display === 'none' ? '' : 'none';
}

let _logEntries = [];
function log(type, title, detail='') {
  const el = document.getElementById('act-log');
  const row = document.createElement('div');
  row.className = 'act-row';
  row.innerHTML = `<div class="act-ic ${type}">${logIcon(type)}</div><div class="act-txt"><div class="act-title">${esc(title)}</div>${detail?`<div class="act-detail">${esc(detail)}</div>`:''}</div>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  _logEntries.push(row);
  return row;
}

function updateLastLog(type, title, detail='') {
  if (_logEntries.length) {
    const row = _logEntries[_logEntries.length-1];
    row.innerHTML = `<div class="act-ic ${type}">${logIcon(type)}</div><div class="act-txt"><div class="act-title">${esc(title)}</div>${detail?`<div class="act-detail">${esc(detail)}</div>`:''}</div>`;
  }
}

function logIcon(type) {
  const icons = {
    run:`<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6l5.2 3.1 1-1.7-4.2-2.4V7z"/></svg>`,
    ok:`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`,
    err:`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    info:`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 6a1 1 0 100-2 1 1 0 000 2zM6.5 7.75A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75z"/></svg>`,
    agent:`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM3.75 2a1.25 1.25 0 100 2.5A1.25 1.25 0 003.75 2zm6.5 1.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zm2.25-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5zM0 12C0 9.51 2.01 8 4 8s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 010 12.75V12zm4-2.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5zm8-2.5c2 0 4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 018 12.75V12c0-2.49 2.01-4 4-4zm0 1.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5z"/></svg>`,
  };
  return icons[type] || icons.info;
}

function clearActivityLog() { document.getElementById('act-log').innerHTML = ''; _logEntries = []; }

// ═══════════════════════════════════════════
// COMPUTER VIEW
// Ventana en vivo (estilo navegador/terminal/editor) que
// refleja, frame a frame, los eventos "computer" reales que
// manda el servidor mientras busca en internet, lee/escribe
// archivos del repo real o ejecuta comandos reales en el
// workspace. No hay nada simulado aqui: cada linea que se
// pinta corresponde a un evento que ya ocurrio en el backend.
// ═══════════════════════════════════════════
let _cvCollapsedByUser = false;
let _cvHideTimer = null;

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function cvShow() {
  clearTimeout(_cvHideTimer);
  const el = document.getElementById('computer-view');
  el.classList.add('show');
  if (!_cvCollapsedByUser) el.classList.remove('collapsed');
}

function cvHideDelayed(ms = 1400) {
  clearTimeout(_cvHideTimer);
  _cvHideTimer = setTimeout(() => {
    document.getElementById('computer-view')?.classList.remove('show');
  }, ms);
}

function resetComputerView() {
  clearTimeout(_cvHideTimer);
  _cvCollapsedByUser = false;
  _cvMode = null;
  const el = document.getElementById('computer-view');
  el.classList.remove('show', 'collapsed');
  document.getElementById('cv-body').innerHTML = '';
  cvSetAddress('nueva pestaña', false);
  cvSetLive(false);
}

function toggleComputerViewCollapse() {
  const el = document.getElementById('computer-view');
  const nowCollapsed = !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', nowCollapsed);
  _cvCollapsedByUser = nowCollapsed;
}

function cvSetAddress(text, loading) {
  const addrText = document.getElementById('cv-addr-text');
  if (addrText) addrText.textContent = text;
  document.getElementById('cv-loadbar')?.classList.toggle('loading', !!loading);
}

function cvSetLive(on) {
  document.getElementById('cv-badge').style.display = on ? '' : 'none';
}

function cvSetBody(html) {
  const body = document.getElementById('cv-body');
  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
}

function cvAppend(html) {
  const body = document.getElementById('cv-body');
  body.insertAdjacentHTML('beforeend', html);
  body.scrollTop = body.scrollHeight;
}

// Estado del "modo" activo (browser/terminal/files) para saber si hay
// que reiniciar el area de contenido o solo agregarle una linea mas.
let _cvMode = null;

function renderComputerEvent(payload) {
  cvShow();
  cvSetLive(true);
  const { mode } = payload;

  if (mode === 'browser') return cvBrowser(payload);
  if (mode === 'terminal') return cvTerminal(payload);
  if (mode === 'files') return cvFiles(payload);
  if (mode === 'image') return cvImage(payload);
  if (mode === 'docs') return cvDocs(payload);
  if (mode === 'desktop') return cvDesktop(payload);
}

// ─────────────────────────────────────────────────────────
// Modo computadora (estilo Astra): el agente VE una pantalla
// real (Chromium en el servidor) y la controla de forma
// autónoma. Aquí se muestra esa pantalla en vivo, paso a paso,
// con el registro de lo que el agente decide y hace.
// ─────────────────────────────────────────────────────────
function cvDesktop(payload) {
  if (_cvMode !== 'desktop') {
    _cvMode = 'desktop';
    cvSetBody(`
      <div class="cv-desk">
        <div class="cv-desk-task" id="cv-desk-task"></div>
        <div class="cv-desk-screen"><img id="cv-desk-shot" alt="Pantalla del agente"></div>
        <div class="cv-desk-steps" id="cv-desk-steps"></div>
      </div>
    `);
  }
  const shot = document.getElementById('cv-desk-shot');
  const steps = document.getElementById('cv-desk-steps');
  const taskEl = document.getElementById('cv-desk-task');
  const log = (html) => {
    if (!steps) return;
    steps.insertAdjacentHTML('beforeend', `<div class="cv-desk-step">${html}</div>`);
    const body = document.getElementById('cv-body');
    if (body) body.scrollTop = body.scrollHeight;
  };
  const setShot = (b64) => { if (shot && b64) shot.src = 'data:image/jpeg;base64,' + b64; };

  if (payload.action === 'start') {
    if (taskEl) taskEl.innerHTML = `🖥️ <b>Tarea:</b> ${esc(payload.task || '')}`;
    cvSetAddress('modo computadora — en vivo', true);
    log(payload.vision
      ? `👁️ El agente está <b>viendo</b> la pantalla.`
      : `⚙️ Visión no disponible: el agente trabaja con la estructura de la página.`);
  } else if (payload.action === 'observe') {
    setShot(payload.screenshot);
    cvSetAddress(payload.url ? String(payload.url).replace(/^https?:\/\//, '').slice(0, 60) : 'navegador del agente', true);
    log(`<span class="cv-desk-n">Paso ${payload.step}</span> 👁️ Observando${payload.title ? `: <i>${esc(payload.title)}</i>` : ''}`);
  } else if (payload.action === 'decide') {
    const actLabel = { click: '👆 clic', type: '⌨️ escribir', press: '🔘 tecla', scroll: '↕️ scroll', navigate: '🌐 ir a', wait: '⏳ esperar', done: '✅ terminar', fail: '❌ abandonar' }[payload.act] || 'acción';
    log(`<span class="cv-desk-n">🧠</span> ${actLabel}${payload.detail ? ` — ${esc(payload.detail)}` : ''}${payload.reasoning ? `<div class="cv-desk-why">${esc(payload.reasoning)}</div>` : ''}`);
  } else if (payload.action === 'act') {
    log(`<span class="cv-desk-n">⚡</span> ${esc(payload.detail || '')} <span class="cv-desk-dim">→ ${esc(payload.result || '')}</span>`);
  } else if (payload.action === 'error') {
    log(`<span class="cv-desk-n">⚠️</span> ${esc(payload.detail || 'Error')}`);
  } else if (payload.action === 'finish') {
    setShot(payload.screenshot);
    cvSetAddress('modo computadora — terminado', false);
    log(`${payload.ok ? '✅' : '⚠️'} <b>${esc(payload.summary || '')}</b>`);
  } else if (payload.action === 'confirm-request') {
    const cid = String(payload.confirmId || '').replace(/[^a-z0-9-]/gi, '');
    log(`<span class="cv-desk-n">🛡️</span> <b>El agente pide tu aprobación:</b><div class="cv-desk-why">${esc(payload.detail || '')}${payload.reason ? `<br><span class="cv-desk-dim">${esc(payload.reason)}</span>` : ''}</div>
      <div class="cv-desk-confirm" id="cv-confirm-${cid}">
        <button class="cv-btn-approve" data-cid="${cid}" data-ok="1">✅ Aprobar</button>
        <button class="cv-btn-deny" data-cid="${cid}" data-ok="0">❌ Denegar</button>
      </div>`);
    steps.querySelectorAll(`#cv-confirm-${cid} button`).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const approved = btn.dataset.ok === '1';
        const box = document.getElementById(`cv-confirm-${cid}`);
        btn.disabled = true;
        try {
          const resp = await apiFetch(`${API}/computer/confirm`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: S.sessionId, confirmId: cid, approved }),
          });
          if (!resp.ok) {
            const d = await resp.json().catch(() => ({}));
            throw new Error(d.error || `Error ${resp.status}`);
          }
        } catch (e) {
          // Nada de marcar "Aprobada" si el servidor no lo registró:
          // se avisa con el motivo real y el botón queda reintentable.
          btn.disabled = false;
          showToast('No se pudo registrar tu respuesta: ' + e.message);
          return;
        }
        if (box) box.innerHTML = `<span class="cv-desk-dim">${approved ? '✅ Aprobada' : '❌ Denegada'}</span>`;
      });
    });
  } else if (payload.action === 'confirm-result') {
    log(`<span class="cv-desk-dim">${payload.approved ? '✅ Aprobación registrada, el agente continúa.' : '❌ Acción no aprobada.'}</span>`);
  }
}

// Tarjeta visual para el Document Studio (documentos, presentaciones
// y hojas de cálculo reales .docx/.pptx/.xlsx, descargables).
function cvDocs(payload) {
  const kindIcon = { documento: '📝', presentacion: '📊', hoja: '📗' }[payload.kind] || '📄';
  const kindLabel = { documento: 'documento Word', presentacion: 'presentación PowerPoint', hoja: 'hoja de cálculo Excel' }[payload.kind] || 'documento';
  if (_cvMode !== 'docs') { _cvMode = 'docs'; cvSetBody('<div id="cv-docs-list"></div>'); }
  const list = document.getElementById('cv-docs-list') || (() => { cvSetBody('<div id="cv-docs-list"></div>'); return document.getElementById('cv-docs-list'); })();
  if (payload.action === 'start') {
    cvSetAddress('creando documento', true);
    list.insertAdjacentHTML('beforeend', `
      <div class="cv-doc-gen">
        <div class="cv-doc-icon">${kindIcon}</div>
        <div class="cv-img-prompt">Creando ${esc(kindLabel)}: “${esc(payload.title || '')}”<span class="cv-term-caret"></span></div>
      </div>
    `);
  } else if (payload.action === 'done' && payload.fileName) {
    cvSetAddress('documento listo', false);
    const url = esc(payload.url || '#');
    const kb = payload.bytes ? `${Math.round(payload.bytes / 1024)} KB` : '';
    const gens = list.querySelectorAll('.cv-doc-gen');
    if (gens.length) gens[gens.length - 1].remove();
    list.insertAdjacentHTML('beforeend', `
      <div class="cv-doc-done">
        <div class="cv-doc-icon">${kindIcon}</div>
        <div class="cv-doc-meta">
          <div class="cv-doc-name">${esc(payload.fileName)}</div>
          <div class="cv-doc-sub">${esc(kindLabel)} · ${esc(payload.title || '')} ${kb ? `· ${kb}` : ''}</div>
        </div>
        <a class="cv-doc-dl" href="${url}" download>⬇ Descargar</a>
      </div>
    `);
  }
  const body = document.getElementById('cv-body');
  if (body) body.scrollTop = body.scrollHeight;
}

// Tarjeta visual para imágenes generadas con IA (gratis, sin clave).
function cvImage(payload) {
  if (_cvMode !== 'image') { _cvMode = 'image'; cvSetBody(''); }
  if (payload.action === 'start') {
    cvSetAddress('generador de imágenes — IA', true);
    cvSetBody(`
      <div class="cv-image-gen">
        <div class="cv-img-shimmer"></div>
        <div class="cv-img-prompt">🎨 Generando: “${esc(payload.prompt || '')}”</div>
      </div>
    `);
  } else if (payload.action === 'done' && payload.url) {
    cvSetAddress('imagen generada', false);
    const url = esc(payload.url);
    cvSetBody(`
      <div class="cv-image-gen">
        <a href="${url}" target="_blank" rel="noopener"><img class="cv-img" src="${url}" alt="${esc(payload.prompt || 'imagen generada por IA')}" loading="lazy"></a>
        <div class="cv-img-prompt">🎨 ${esc(payload.prompt || '')}</div>
        <a class="cv-img-open" href="${url}" target="_blank" rel="noopener">Abrir en tamaño completo ↗</a>
      </div>
    `);
  }
}

function cvBrowser(payload) {
  if (_cvMode !== 'browser') { _cvMode = 'browser'; cvSetBody(''); }

  if (payload.action === 'search') {
    const engineLabel = payload.engine === 'wikipedia' ? 'Enciclopedia' : 'google.com/search';
    const engineUrl = payload.engine === 'wikipedia'
      ? `es.wikipedia.org/w/index.php?search=${encodeURIComponent(payload.query)}`
      : `google.com/search?q=${encodeURIComponent(payload.query)}`;
    cvSetAddress(engineUrl, true);
    cvSetBody(`
      <div class="cv-search-row">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
        <div>Buscando en <b>${esc(engineLabel)}</b>: “${esc(payload.query)}”<span class="cv-term-caret"></span></div>
      </div>
    `);
  } else if (payload.action === 'visit') {
    cvSetAddress(payload.url, true);
    const host = domainOf(payload.url);
    cvSetBody(`
      <div class="cv-page">
        <div class="cv-page-source">
          <div class="cv-favicon">${esc(host.slice(0,1).toUpperCase())}</div>
          <span class="cv-page-host">${esc(host)}</span>
        </div>
        <div class="cv-page-title">${esc(payload.title || host)}</div>
        <div class="cv-page-snippet">${esc(payload.snippet || 'Cargando contenido de la página…')}</div>
      </div>
    `);
    setTimeout(() => cvSetAddress(payload.url, false), 450);
  } else if (payload.action === 'search_done') {
    cvSetAddress(document.getElementById('cv-addr-text')?.textContent || '', false);
    cvAppend(`<div class="cv-results-count">${payload.count ? `${payload.count} resultado(s) encontrados` : 'Sin resultados'}</div>`);
  }
}

function cvTerminal(payload) {
  if (_cvMode !== 'terminal') { _cvMode = 'terminal'; cvSetBody('<div class="cv-term" id="cv-term"></div>'); }
  const term = document.getElementById('cv-term') || (() => { cvSetBody('<div class="cv-term" id="cv-term"></div>'); return document.getElementById('cv-term'); })();

  if (payload.action === 'run') {
    cvSetAddress('terminal', true);
    term.insertAdjacentHTML('beforeend', `<div class="cv-term-line cv-term-cmd">Ejecutando…</div>`);
  } else if (payload.action === 'output') {
    cvSetAddress(document.getElementById('cv-addr-text')?.textContent || 'terminal', false);
    term.insertAdjacentHTML('beforeend', `<div class="cv-term-line cv-term-out${payload.ok === false ? ' err' : ''}">${esc(payload.text || '')}</div>`);
  } else if (payload.action === 'done') {
    cvSetAddress('terminal', false);
    term.insertAdjacentHTML('beforeend', `<div class="cv-term-line cv-term-out${payload.ok === false ? ' err' : ''}">${esc(payload.text || '')}</div>`);
  }
  term.scrollTop = term.scrollHeight;
}

function cvFiles(payload) {
  if (_cvMode !== 'files') { _cvMode = 'files'; cvSetBody('<div class="cv-files" id="cv-files"></div>'); }
  const wrap = document.getElementById('cv-files') || (() => { cvSetBody('<div class="cv-files" id="cv-files"></div>'); return document.getElementById('cv-files'); })();
  const fileSvg = `<svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M3.75 1.5a.25.25 0 00-.25.25v11.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6H9.75A1.75 1.75 0 018 4.25V1.5H3.75z"/></svg>`;

  if (payload.action === 'listing') {
    cvSetAddress(`${payload.path || 'repositorio'} — explorador de archivos`, true);
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path || 'repositorio')}</span><span class="cv-file-status">${payload.count ?? 0} archivos</span></div>`;
  } else if (payload.action === 'open') {
    cvSetAddress(payload.path, true);
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path)}</span><span class="cv-file-status">abriendo…</span></div>
      <div class="cv-file-shimmer" style="width:88%"></div>
      <div class="cv-file-shimmer" style="width:64%"></div>
      <div class="cv-file-shimmer" style="width:76%"></div>`;
  } else if (payload.action === 'read') {
    cvSetAddress(payload.path, false);
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path)}</span><span class="cv-file-status">${payload.lines} líneas</span></div>
      <div class="cv-file-code">${esc(payload.preview || '')}</div>`;
  } else if (payload.action === 'write' || payload.action === 'write_failed') {
    const ok = payload.action === 'write';
    cvSetAddress(payload.path, false);
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path || '')}</span><span class="cv-file-status">${ok ? 'guardado' : 'no aplicado'}</span></div>
      ${!ok && payload.text ? `<div class="cv-file-code">${esc(payload.text)}</div>` : ''}`;
  } else if (payload.action === 'error') {
    cvSetAddress(payload.path, false);
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path)}</span><span class="cv-file-status">error</span></div>
      <div class="cv-file-code">${esc(payload.text || '')}</div>`;
  }
}

function updateContextBar(tokens) {
  S.totalTokens = tokens;
  const pct = Math.min(100, Math.round((tokens / S.maxTokens) * 100));
  const bar = document.getElementById('context-bar');
  const fill = document.getElementById('ctx-fill');
  const pctEl = document.getElementById('ctx-pct');

  if (tokens > 0) bar?.classList.add('show');
  if (fill) { fill.style.width = pct + '%'; fill.className = 'ctx-fill' + (pct > 90 ? ' full' : pct > 70 ? ' warn' : ''); }
  if (pctEl) pctEl.textContent = pct + '%';
  syncStatusBar();
}

let _toastT;
function showToast(t) {
  const el = document.getElementById('toast');
  el.textContent = t;
  el.classList.add('on');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('on'), 2600);
}

function now() {
  return new Date().toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit' });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Inverso exacto de esc() — recupera el texto original de un
// bloque de codigo que fue escapado para mostrarse como HTML.
// El orden de reemplazo importa: &amp; se revierte al final,
// si no "&amp;lt;" se convertiria mal a "&<" en vez de "&lt;".
function unescapeHtml(s) {
  return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
}

// ═══════════════════════════════════════════
// MARKDOWN + DIFF RENDERER
// ═══════════════════════════════════════════
// Registro del texto CRUDO de cada bloque de diff, indexado
// por el mismo id que lleva su <pre>. El HTML del <pre> esta
// coloreado con spans (diff-add/diff-del/...), asi que no sirve
// para reconstruir el patch real — este registro es la unica
// fuente confiable del texto exacto que hay que aplicar.
const DIFF_RAW = new Map();

// Busca, dentro de los diffs que el backend ya proceso automaticamente
// en este mismo turno (S.lastAppliedDiffs), una entrada que corresponda
// al texto crudo de este bloque de codigo. Comparamos el diff completo
// recortado: es la misma fuente de verdad (diffBlock) que usa el server.
function findAutoAppliedEntry(rawDiff) {
  const list = (typeof S !== 'undefined' && Array.isArray(S.lastAppliedDiffs)) ? S.lastAppliedDiffs : [];
  const key = String(rawDiff || '').trim();
  return list.find((d) => d.diff === key) || null;
}

// Convierte el bloque de texto real que devuelve una herramienta
// (busqueda/wikipedia/video/imagen, ver runToolCommand en
// chatRoutes.js) en una tarjeta visual. Si el formato no calza
// exactamente con lo esperado, cae a texto simple — nunca se
// inventa contenido que el backend no devolvio.
function renderMediaBlock(kind, raw) {
  try {
    if (kind === 'Resultado de búsqueda web') return renderSearchCard(raw);
    if (kind === 'Wikipedia') return renderWikiCard(raw);
    if (kind === 'Video generado') return renderVideoCard(raw);
    if (kind === 'Imagen editada') return renderImageCard(raw);
  } catch (e) {
    console.error('[media-card] fallo al renderizar, uso texto plano:', e);
  }
  return `<div class="media-card"><div class="media-card-body" style="padding:10px 12px;font-size:12px;white-space:pre-wrap">${esc(raw)}</div></div>`;
}

function renderSearchCard(raw) {
  const titleMatch = raw.match(/^### Resultado de búsqueda web: "(.+)"/);
  const query = titleMatch ? titleMatch[1] : 'Búsqueda';
  const answerMatch = raw.match(/Respuesta directa: ([\s\S]*?)\n\n/);
  const items = [...raw.matchAll(/\d+\.\s\*\*(.+?)\*\*\s—\s(\S+)\n\s*(.*)/g)];

  const answerHtml = answerMatch ? `<div class="media-search-answer">${esc(answerMatch[1].trim())}</div>` : '';
  const listHtml = items.length
    ? `<div class="media-search-list">${items.map(([, title, url, snippet]) => `
        <a class="media-search-item" href="${esc(url)}" target="_blank" rel="noopener">
          <div class="media-search-item-title">${esc(title)}</div>
          <div class="media-search-item-url">${esc(new URL(url).hostname)}</div>
          <div class="media-search-item-snippet">${esc(snippet || '')}</div>
        </a>`).join('')}</div>`
    : `<div class="media-card-body" style="padding:12px;font-size:12px;color:var(--text3)">Sin resultados.</div>`;

  return `<div class="media-card">
    <div class="media-card-head">
      <div class="media-card-ic search"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-.326 1.275.749.749 0 01-.734-.215l-3.04-3.04z"/></svg></div>
      <div class="media-card-title">${esc(query)}</div>
      <div class="media-card-badge">${items.length} resultado${items.length===1?'':'s'}</div>
    </div>
    ${answerHtml}${listHtml}
  </div>`;
}

function renderWikiCard(raw) {
  const titleMatch = raw.match(/^### Wikipedia: (.+)/);
  const title = titleMatch ? titleMatch[1].replace(/^"|"$/g, '') : 'Dato';
  const notFound = raw.includes('No se encontró ningún artículo');
  const urlMatch = raw.match(/Fuente: (\S+)/);
  const extract = raw
    .replace(/^### Wikipedia: .+\n?/, '')
    .replace(/\n\nFuente: \S+\s*$/, '')
    .trim();

  return `<div class="media-card">
    <div class="media-card-head">
      <div class="media-card-ic search" style="background:rgba(88,127,92,.1);color:var(--green)"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/></svg></div>
      <div class="media-card-title">${esc(title)}</div>
      <div class="media-card-badge">Enciclopedia</div>
    </div>
    <div class="media-card-body" style="padding:10px 12px;font-size:12.5px;color:var(--text2);line-height:1.6">
      ${notFound ? 'No se encontró ningún artículo relevante.' : esc(extract)}
    </div>
    ${urlMatch ? `<div class="media-card-footer"><a href="${esc(urlMatch[1])}" target="_blank" rel="noopener" style="color:var(--accent2);font-weight:600">Ver artículo completo →</a></div>` : ''}
  </div>`;
}

function renderVideoCard(raw) {
  const titleMatch = raw.match(/^### Video generado: "(.+)"/);
  const prompt = titleMatch ? titleMatch[1] : 'Video generado';
  const totalMatch = raw.match(/Duración total: (\d+)s en (\d+) clip/);
  const clips = [...raw.matchAll(/- Clip (\d+) \((\d+)s\): (\S+)/g)]
    .map(([, index, seconds, url]) => ({ index, seconds, url }));

  if (!clips.length) {
    return `<div class="media-card"><div class="media-card-body" style="padding:12px;font-size:12px;color:var(--text3)">${esc(raw)}</div></div>`;
  }

  const clipId = 'vid' + Math.random().toString(36).slice(2, 8);
  const chips = clips.map((c, i) => `<button class="media-clip-chip${i===0?' active':''}" onclick="switchVideoClip('${clipId}',${i})" data-i="${i}">Clip ${c.index} · ${c.seconds}s</button>`).join('');

  return `<div class="media-card" id="${clipId}" data-urls='${esc(JSON.stringify(clips.map(c=>c.url)))}'>
    <div class="media-card-head">
      <div class="media-card-ic video"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5A1.5 1.5 0 012.5 2h6A1.5 1.5 0 0110 3.5v9a1.5 1.5 0 01-1.5 1.5h-6A1.5 1.5 0 011 12.5v-9zm12.5 1.191l-2.7 1.542v3.534l2.7 1.542a.5.5 0 00.75-.433V5.124a.5.5 0 00-.75-.433z"/></svg></div>
      <div class="media-card-title">${esc(prompt)}</div>
      ${totalMatch ? `<div class="media-card-badge">${totalMatch[1]}s</div>` : ''}
    </div>
    <div class="media-video-wrap"><video id="${clipId}-player" controls playsinline src="${esc(clips[0].url)}"></video></div>
    ${clips.length > 1 ? `<div class="media-clip-strip">${chips}</div>` : ''}
    <div class="media-card-footer">
      <span>${totalMatch ? `${totalMatch[2]} clip(s) encadenados` : ''}</span>
    </div>
  </div>`;
}

function switchVideoClip(cardId, index) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const urls = JSON.parse(unescapeHtml(card.dataset.urls || '[]'));
  const player = document.getElementById(`${cardId}-player`);
  if (player && urls[index]) { player.src = urls[index]; player.play().catch(() => {}); }
  card.querySelectorAll('.media-clip-chip').forEach((chip, i) => chip.classList.toggle('active', i === index));
}

function renderImageCard(raw) {
  const instructionMatch = raw.match(/Instrucción: (.+)/);
  const resultMatch = raw.match(/Resultado: (\S+)/);
  const noteMatch = raw.match(/Nota: ([\s\S]+)$/);
  const failed = raw.includes('No se pudo generar la imagen editada');

  return `<div class="media-card">
    <div class="media-card-head">
      <div class="media-card-ic image"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M6.002 5.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/><path d="M2.002 1a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V3a2 2 0 00-2-2h-12zm12 1a1 1 0 011 1v6.5l-3.777-1.947a.5.5 0 00-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 00-.63.062L1.002 12V3a1 1 0 011-1h12z"/></svg></div>
      <div class="media-card-title">${esc(instructionMatch ? instructionMatch[1] : 'Imagen editada')}</div>
    </div>
    ${resultMatch
      ? `<div class="media-image-wrap"><img src="${esc(resultMatch[1])}" alt="Imagen editada" loading="lazy" onclick="window.open('${esc(resultMatch[1])}','_blank')"></div>`
      : `<div class="media-card-body" style="padding:12px;font-size:12px;color:var(--red)">${failed ? 'No se pudo generar la imagen editada.' : esc(raw)}</div>`}
    ${noteMatch ? `<div class="media-card-footer">${esc(noteMatch[1].trim())}</div>` : ''}
  </div>`;
}

// Líneas de protocolo interno que el modelo a veces emite en su texto
// ("Ejecuta: ...", "Buscar: ...", "Crear script: ..."): son
// instrucciones para el sistema, no parte de la respuesta — nunca se
// muestran al usuario. Se quitan solo fuera de bloques de código
// cercados, para no tocar ejemplos que el usuario pidió ver.
function stripProtocolLines(text) {
  const PROTOCOL = /^\s*#{0,3}\s*(ejecuta|buscar|wikipedia|crear script|generar video|editar imagen|generar imagen|crear documento|crear presentación|crear hoja|investigar|revisar código|buscar en internet)\s*:/i;
  const lines = String(text || '').split('\n');
  let inFence = false;
  const kept = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && PROTOCOL.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function md(text) {
  // Antes de tocar markdown normal, extraemos los bloques que
  // toolsClient/chatRoutes generan para busqueda web, Wikipedia,
  // video e imagenes, y los reemplazamos por marcadores. Asi el
  // renderer de markdown de abajo nunca los toca, y al final los
  // sustituimos por las tarjetas HTML ricas correspondientes.
  const mediaBlocks = [];
  const withPlaceholders = String(text).replace(
    /^### (Video generado|Imagen editada|Resultado de búsqueda web|Wikipedia)[^\n]*\n([\s\S]*?)(?=\n### |\n?$)/gm,
    (whole, kind, body) => {
      const idx = mediaBlocks.length;
      mediaBlocks.push(renderMediaBlock(kind, whole));
      return `\u0000MEDIA_BLOCK_${idx}\u0000`;
    }
  );

  let s = esc(withPlaceholders);

  // Code blocks
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb' + Math.random().toString(36).slice(2,7);
    const isDiff = lang === 'diff' || (!lang && code.match(/^[+-]/m));
    let rendered = code;
    let btnsHtml = '';
    if (isDiff) {
      // Guardamos el texto crudo (sin escapar de HTML) ahora,
      // antes de perderlo entre los spans de color.
      const rawDiff = unescapeHtml(code);
      DIFF_RAW.set(id, rawDiff);
      rendered = code.split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${line}</span>`;
        if (line.startsWith('@@')) return `<span class="diff-hunk">${line}</span>`;
        return `<span class="diff-ctx">${line}</span>`;
      }).join('\n');

      // Si el servidor YA proceso este diff automaticamente (autoApply),
      // no mostramos un boton "Aplicar" activo: volver a aplicarlo contra
      // un archivo que ya cambio siempre fallaba con "el diff no
      // coincide". En vez de eso mostramos el resultado real.
      const autoEntry = findAutoAppliedEntry(rawDiff);
      if (autoEntry && autoEntry.applied) {
        btnsHtml = `<span class="cblock-status ok">${checkSvg()} Aplicado automaticamente</span>`;
      } else if (autoEntry && !autoEntry.applied) {
        const reason = autoEntry.alreadyApplied ? 'Este cambio ya estaba aplicado' : (autoEntry.reason || 'No se pudo aplicar');
        btnsHtml = `<span class="cblock-status err" title="${esc(reason)}">${xSvg()} ${esc(reason)}</span>`;
      } else {
        btnsHtml = `<button class="cblock-btn apply" onclick="applyDiff('${id}',this)">${checkSvg()} Aplicar</button><button class="cblock-btn reject" onclick="rejectDiff(this)">${xSvg()} Descartar</button>`;
      }
    }
    const applyBtn = btnsHtml;
    return `<div class="cblock"><div class="cblock-head"><span class="clang">${lang||'code'}</span><div class="cblock-btns">${applyBtn}<button class="cblock-btn copy" onclick="cpBlock('${id}',this)">${copySvg()} Copiar</button></div></div><pre id="${id}">${rendered}</pre></div>`;
  });

  // Tablas markdown: | col | col | con su fila separadora |---|---|
  // Se extraen a HTML real (con scroll horizontal) antes de las
  // reglas de párrafo, que si no las destrozarían.
  const tableBlocks = [];
  s = s.replace(/((?:^\|.+\|\s*$\n?)+)/gm, (block) => {
    const rows = block.trim().split('\n').map((r) => r.trim());
    if (rows.length < 2 || !/^\|[\s:|-]+\|$/.test(rows[1])) return block;
    const inl = (t) => t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inl(c.trim()));
    const head = cells(rows[0]);
    const bodyRows = rows.slice(2).map(cells);
    const idx = tableBlocks.length;
    tableBlocks.push(`<div class="md-table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    // El salto de línea final se conserva: si no, la línea siguiente
    // queda pegada al marcador y deja de reconocerse (p. ej. "1. …").
    return `\u0000TABLE_${idx}\u0000\n`;
  });

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul>${m.trim()}</ul>`);
  s = s.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');
  s = s.replace(/(<oli>[\s\S]*?<\/oli>\n?)+/g, m => `<ol>${m.trim().replace(/<\/?oli>/g, (t) => t.startsWith('</') ? '</li>' : '<li>')}</ol>`);
  s = s.replace(/^---+$/gm, '<hr>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // URLs sueltas clicables (nunca dentro de un href ya generado).
  s = s.replace(/(^|[^"=\]])\b(https?:\/\/[^\s<")]+[^\s<").,;:])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  // Citas [n] del Deep Research: clicables, saltan a la fuente del mensaje.
  s = s.replace(/\[(\d+)\](?!\()/g, '<a class="cite" href="#" onclick="scrollToSource(this,$1);return false">[$1]</a>');
  s = s.replace(/^(?!<[hulo]|<li|<hr|<div|<pre|<ul|<block|\u0000(?:MEDIA_BLOCK|TABLE)_)(.+)$/gm, '<p>$1</p>');
  s = s.replace(/<p><\/p>/g, '');

  // Sustituimos los marcadores por las tarjetas HTML reales, ahora
  // que el markdown alrededor ya esta resuelto.
  s = s.replace(/\u0000MEDIA_BLOCK_(\d+)\u0000/g, (_, i) => mediaBlocks[Number(i)] || '');
  s = s.replace(/\u0000TABLE_(\d+)\u0000/g, (_, i) => tableBlocks[Number(i)] || '');

  return s;
}

function copySvg() { return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>`; }
function checkSvg() { return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`; }
function xSvg() { return `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>`; }

function cpBlock(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText || el.textContent).then(() => {
    btn.innerHTML = checkSvg() + ' Copiado';
    btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = copySvg() + ' Copiar'; btn.classList.remove('done'); }, 1800);
  });
}
async function applyDiff(id, btn) {
  const rawDiff = DIFF_RAW.get(id);
  if (!rawDiff) { showToast('No se encontro el contenido del cambio'); return; }
  if (!S.sessionId || !S.repoData) { showToast('Conecta un repositorio primero'); return; }

  const originalLabel = btn.innerHTML;
  btn.innerHTML = '<div class="btn-spinner"></div> Aplicando...';
  btn.disabled = true;

  try {
    const resp = await apiFetch(`${API}/agent/apply-diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId, diff: rawDiff }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);

    const failed = (data.results || []).filter((r) => !r.applied);
    const applied = (data.results || []).filter((r) => r.applied);

    if (applied.length) {
      buzz([20, 50, 20]);
      // Estos SI son archivos reales, modificados de verdad en
      // el clon en disco — es lo que se ve reflejado en el
      // modal de push (openPushModal) y lo que confirmPush sube.
      for (const r of applied) {
        if (!S.pendingEdits.some((e) => e.path === r.path)) S.pendingEdits.push({ path: r.path });
      }
      updateTasksBadge();
      showPushBanner(S.pendingEdits.map((e) => e.path));
    }

    if (failed.length) {
      btn.innerHTML = xSvg() + ' No aplicado';
      btn.classList.add('reject');
      const failure = failed[0];
      if (failure.alreadyApplied) {
        btn.innerHTML = checkSvg() + ' Ya aplicado';
        btn.classList.remove('reject');
        btn.classList.add('done');
      }
      showToast(failure.reason || 'El cambio no coincide con el archivo actual');
    } else {
      const anyAlready = applied.some((a) => a.alreadyApplied);
      btn.innerHTML = checkSvg() + (anyAlready ? ' Ya aplicado' : ' Aplicado');
      btn.classList.add('done');
      showToast(anyAlready
        ? `Este cambio ya estaba aplicado en: ${applied.map((a) => a.path).join(', ')}`
        : `Aplicado de verdad: ${applied.map((a) => a.path).join(', ')}`);
    }
    btn.disabled = true;
  } catch (e) {
    btn.innerHTML = originalLabel;
    btn.disabled = false;
    showToast('Error aplicando el cambio: ' + e.message);
  }
}

// Una cita [n] lleva a la fuente n-ésima del mismo mensaje (tarjeta
// de búsqueda) y la resalta un instante. Si no hay tarjeta, no pasa nada.
function scrollToSource(link, n) {
  const msg = link.closest('.msg');
  if (!msg) return;
  const items = msg.querySelectorAll('.media-search-item');
  const target = items[n - 1] || msg.querySelector('.media-card');
  if (!target) { showToast('Fuente no visible en este mensaje'); return; }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1600);
}

function rejectDiff(btn) {
  const block = btn.closest('.cblock');
  if (block) { block.style.opacity = '0.3'; block.style.pointerEvents = 'none'; }
  showToast('Cambio descartado');
}

// ═══════════════════════════════════════════
// TOOL CALL CARDS (Claude Code style)
// ═══════════════════════════════════════════
function makeToolCard(type, name, detail, status='run') {
  const div = document.createElement('div');
  div.className = 'tool-card';
  const icons = {
    read: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75zm1.75-.25a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V6h-2.75A1.75 1.75 0 018 4.25V1.5H3.75zm5 .056V4.25c0 .138.112.25.25.25h2.694l-.437-.437L8.75 1.556z"/></svg>`,
    write: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61z"/></svg>`,
    run: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zm4.879-2.773a.5.5 0 01.53.05l3.5 2.5a.5.5 0 010 .846l-3.5 2.5A.5.5 0 016 10.5v-5a.5.5 0 01.379-.273z"/></svg>`,
    search: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-.326 1.275.749.749 0 01-.734-.215l-3.04-3.04z"/></svg>`,
    agent: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zm6.5 1.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0z"/><path d="M0 12C0 9.51 2.01 8 4 8s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 010 12.75V12zm8 0c0-2.49 2.01-4 4-4s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 018 12.75V12z"/></svg>`,
  };
  const statusLabels = { run:'En proceso...', ok:'Completado', err:'Error' };
  div.innerHTML = `<div class="tool-card-head" onclick="buzz(8);this.closest('.tool-card').classList.toggle('open')">
    <div class="tool-ic ${type}">${icons[type]||icons.run}</div>
    <span class="tool-name">${esc(name)}</span>
    <span class="tool-status ${status}">${statusLabels[status]||status}</span>
    <svg class="tool-chevron" viewBox="0 0 16 16" fill="currentColor"><path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/></svg>
  </div>
  <div class="tool-card-body">${esc(detail)}</div>`;
  return div;
}

// ═══════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════
function addMsg(role, text) {
  const msgs = document.getElementById('msgs');
  document.getElementById('empty').classList.add('gone');

  const div = document.createElement('div');
  div.className = `msg ${role}`;

  if (role === 'me') {
    div.innerHTML = `
      <div class="msg-meta">
        <div class="av me">Tu</div>
        <span class="mname">Tu</span>
        <span class="mtime">${now()}</span>
      </div>
      <div class="mbubble"><div class="mbody"><p>${esc(text)}</p></div></div>
      <div class="msg-actions">
        <button class="ma-btn" onclick="copyMsg(this)">${copySvg()} Copiar</button>
      </div>
    `;
  } else {
    div.innerHTML = `
      <div class="msg-meta">
        <div class="av ai">B</div>
        <span class="mname">Baro</span>
        <span class="mtime">${now()}</span>
      </div>
      <div class="mbubble"><div class="mbody">${md(stripProtocolLines(text))}</div></div>
      <div class="msg-actions">
        <button class="ma-btn" onclick="copyMsg(this)">${copySvg()} Copiar</button>
        <button class="ma-btn" onclick="regen(this)">
          <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
          Regenerar
        </button>
      </div>
    `;
  }

  msgs.appendChild(div);
  if (isNearBottom()) scrollChatToBottom(false);
  return div;
}

function copyMsg(btn) {
  const body = btn.closest('.msg')?.querySelector('.mbody');
  if (!body) return;
  navigator.clipboard.writeText(body.innerText || body.textContent).then(() => { buzz(10); showToast('Copiado'); });
}

function regen(btn) {
  const lastUser = [...document.querySelectorAll('.msg.me .mbody p')].pop();
  if (!lastUser) return;
  const text = lastUser.textContent;
  const lastAi = [...document.querySelectorAll('.msg.ai')].pop();
  if (lastAi) lastAi.remove();
  S.history = S.history.slice(0, -1);
  doQuick(text);
}

function mkStream() {
  const msgs = document.getElementById('msgs');
  document.getElementById('empty').classList.add('gone');
  const div = document.createElement('div');
  div.className = 'msg ai gen';
  div.innerHTML = `
    <div class="gen-status"><svg class="logo-svg" viewBox="0 0 48 48" width="26" height="26" aria-hidden="true" focusable="false"><use href="#baro-mark"/></svg><span>Generando…</span></div>
    <div class="mbubble"><div class="mbody"></div></div>
  `;
  msgs.appendChild(div);
  if (isNearBottom()) scrollChatToBottom(false);
  return div;
}

// Throttle del re-render en vivo: re-pintar markdown en cada token
// es O(n²) de DOM. Se pinta como maximo cada 120ms; el render final
// siempre es forzado para no perder el ultimo fragmento.
let _lastPatchMs = 0;
function patchStream(div, text, force) {
  const body = div.querySelector('.mbody');
  if (!body) return;
  const nowMs = Date.now();
  if (!force && nowMs - _lastPatchMs < 120) return;
  _lastPatchMs = nowMs;
  body.innerHTML = md(stripProtocolLines(text)) + '<span class="scursor"></span>';
  if (isNearBottom()) scrollChatToBottom(false);
}

function finalStream(div, text) {
  // Fin del turno: se retira el estado "Generando…" y la burbuja
  // queda con el aspecto normal de mensaje de Baro.
  div.classList.remove('gen');
  div.querySelector('.gen-status')?.remove();
  const body = div.querySelector('.mbody');
  if (!body) return;
  body.innerHTML = md(stripProtocolLines(text));
  // Add action buttons
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `
    <button class="ma-btn" onclick="copyMsg(this)">${copySvg()} Copiar</button>
    <button class="ma-btn" onclick="regen(this)"><svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg> Regenerar</button>
  `;
  div.appendChild(actions);
  saveChatHistory();
}

// ═══════════════════════════════════════════
// AI — via backend real (trabajos async, v10 H2)
// POST /api/chat ya no devuelve el stream del turno: crea un
// trabajo y responde 202 con su id. El turno sigue corriendo en
// el servidor aunque se cierre la pestaña; el cliente se engancha
// a sus eventos con attachToJob() y los reproduce (los ya
// guardados primero, luego en vivo). El protocolo de eventos es
// el mismo de siempre (plan/verify/log/computer/delta/done/error).
// ═══════════════════════════════════════════
async function callAI(msg, onStream) {
  await ensureSession();

  S.abortController = new AbortController();

  const makeBody = () => JSON.stringify({
    sessionId: S.sessionId,
    message: msg,
    threadId: S.currentThreadId,
    planMode: S.planModeEnabled,
    fileLimit: S.fileLimit,
    // El segmented Auto/Preguntar del composer manda de verdad:
    // 'ask' deja los diffs con su botón Aplicar, sin auto-aplicar.
    autoApply: S.applyMode !== 'ask',
    // El toggle multi-agente de Config por fin viaja al backend.
    multiAgent: S.multiAgentEnabled,
  });

  const agentToken = (() => { try { return localStorage.getItem('agent_token'); } catch { return null; } })();
  const chatHeaders = { 'Content-Type': 'application/json', ...(agentToken ? { 'x-agent-token': agentToken } : {}) };

  let resp = await authorizedApiFetch(`${API}/chat`, {
    method: 'POST',
    headers: chatHeaders,
    signal: S.abortController.signal,
    body: makeBody(),
  });

  // Sesión expirada → recrear y reintentar
  if (resp.status === 404) {
    const d = await resp.json().catch(() => ({}));
    if (isSessionGone(d)) {
      S.sessionId = null;
      await initSession();
      S.abortController = new AbortController();
      resp = await authorizedApiFetch(`${API}/chat`, {
        method: 'POST',
        headers: chatHeaders,
        signal: S.abortController.signal,
        body: makeBody(),
      });
    }
  }

  if (resp.status !== 202) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Error ${resp.status}`);
  }
  const { jobId } = await resp.json();
  if (!jobId) throw new Error('El servidor no devolvió el trabajo.');
  S.currentJobId = jobId;
  return attachToJob(jobId, onStream, msg);
}

// Pide la cancelación del trabajo en el servidor (el turno se
// detiene de verdad, no solo se cierra el stream local).
async function cancelJob(jobId) {
  if (!jobId) return;
  try {
    await authorizedApiFetch(`${API}/jobs/${jobId}/cancel`, { method: 'POST' });
  } catch { /* si no llega, el turno termina solo; nada se rompe */ }
}

// Se engancha al stream de eventos de un trabajo: reproduce los
// eventos ya guardados y sigue en vivo hasta el estado final.
// Cerrar esta conexión NO cancela el trabajo (sigue en el
// servidor); al volver, attachToJob reconstruye el texto desde
// los deltas guardados. Devuelve el texto final del turno.
async function attachToJob(jobId, onStream, msg) {
  const resp = await authorizedApiFetch(`${API}/jobs/${jobId}/events`, {
    signal: S.abortController?.signal,
  });

  if (!resp.ok || !resp.body) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Error ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';
  let outcome = null;

  const handleEvent = (eventName, payload) => {
    if (eventName === 'plan') {
      // Plan del turno (Codex-style): pasos con estado en vivo.
      renderPlan(payload);
    } else if (eventName === 'verify') {
      // Resultado de la verificación con tests del turno.
      renderVerify(payload);
    } else if (eventName === 'log') {
      // Actividad real del servidor (leyendo archivos reales,
      // ejecutando, etc.) reflejada en el panel de actividad.
      log(payload.type, payload.title, payload.detail || '');
    } else if (eventName === 'computer') {
      // Mismo origen que 'log' (eventos reales del servidor), pero
      // renderizado como una ventana de navegador/terminal/editor
      // en vivo en vez de una linea de texto.
      renderComputerEvent(payload);
    } else if (eventName === 'delta') {
      // El servidor envia SOLO el fragmento nuevo ('delta') y el
      // frontend lo acumula — O(n) de red en vez de O(n²).
      if (payload.delta !== undefined) S.streamAcc += payload.delta;
      else if (payload.text !== undefined) S.streamAcc = payload.text;
      finalText = S.streamAcc;
      if (onStream) onStream(S.streamAcc);
    } else if (eventName === 'error') {
      throw new Error(payload.error);
    } else if (eventName === 'done') {
      finalText = payload.text ?? finalText;
      if (payload.verify) renderVerify(payload.verify);
      if (payload.threadId) {
        // El turno creó (o usó) una conversación: adoptarla para
        // que el siguiente mensaje siga en el mismo hilo.
        S.currentThreadId = payload.threadId;
        loadThreads();
      }
      S.lastAutoAppliedPaths = Array.isArray(payload.autoAppliedPaths) ? payload.autoAppliedPaths : [];
      S.lastAppliedDiffs = Array.isArray(payload.appliedDiffs) ? payload.appliedDiffs : [];
      for (const path of S.lastAutoAppliedPaths) {
        if (!S.pendingEdits.some((edit) => edit.path === path)) S.pendingEdits.push({ path });
      }
      updateTasksBadge();
    } else if (eventName === '__status__') {
      // Estado final del trabajo: aquí termina el stream.
      outcome = payload;
    }
  };

  while (!outcome) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const raw of events) {
      const lines = raw.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const eventName = eventLine.slice(7).trim();
      let payload;
      try { payload = JSON.parse(dataLine.slice(6)); } catch { continue; }
      handleEvent(eventName, payload);
      if (outcome) break;
    }
  }
  try { reader.cancel(); } catch { /* ya cerrado */ }

  if (outcome?.status === 'failed') {
    throw new Error(outcome.error || 'El trabajo terminó con un error.');
  }
  // 'cancelled' o 'done': se devuelve lo acumulado (en cancelado
  // es el texto parcial; send() lo muestra como detenido).

  const estTokens = Math.round((msg.length + finalText.length) / 4) + 400;
  updateContextBar(estTokens);

  return finalText;
}

function detectEditsAndShowPushBanner(text) {
  // Antes esta funcion creaba entradas en S.pendingEdits con
  // newContent/originalContent vacios apenas veia un bloque de
  // diff en la respuesta — eso es lo que causaba que un push
  // pudiera subir archivos en blanco. Ahora S.pendingEdits SOLO
  // se llena en applyDiff(), una vez que el diff se aplico de
  // verdad sobre el archivo real en disco. Aqui solo detectamos
  // que hay diffs disponibles para avisar visualmente.
  if (!S.repoData) return;
  const matches = text.match(/--- a\/(.+)/g) || [];
  if (!matches.length) return;
  const files = [...new Set(matches.map((m) => m.replace('--- a/', '').trim()))];
  if (S.lastAutoAppliedPaths.length) {
    showToast(`${S.lastAutoAppliedPaths.length} cambio(s) aplicado(s) automáticamente`);
    showPushBanner(S.lastAutoAppliedPaths);
  } else {
    showToast(`${files.length} cambio(s) generado(s); revisa el mensaje del agente`);
  }
}

// ═══════════════════════════════════════════
// AUTO ANALYZE
// ═══════════════════════════════════════════
function autoAnalyze() {
  if (!S.repoData) return;
  const msg = `He conectado **${S.repoData.full_name}** en la rama **${S.branch}**. Revisa el proyecto por tu cuenta: mira su estructura y sus archivos principales, identifica las tecnologías que usa, ejecuta las comprobaciones seguras disponibles, corrige los problemas importantes que puedas confirmar, aplica los cambios, vuelve a verificar y termina con un resumen de lo que hiciste y lo que necesita atención. No me pidas confirmación para leer, editar o ejecutar comprobaciones; solo deja el envío a GitHub como acción explícita.`;
  doQuick(msg);
}

// ═══════════════════════════════════════════
// STOP / SEND
// ═══════════════════════════════════════════
function stopGeneration() {
  // Primero se cancela el trabajo en el servidor (el turno se
  // detiene de verdad) y luego se corta el stream local.
  if (S.currentJobId) cancelJob(S.currentJobId);
  if (S.abortController) { S.abortController.abort(); showToast('Detenido'); }
}

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!document.getElementById('sndbtn').disabled) send();
  }
}

async function send() {
  const inp = document.getElementById('inp');
  const msg = inp.value.trim();
  if (!msg || S.busy) return;

  buzz([15, 40, 15]);
  S.busy = true;
  inp.value = '';
  inp.style.height = 'auto';
  document.getElementById('sndbtn').disabled = true;

  addMsg('me', msg);
  clearActivityLog();
  resetComputerView();
  resetPlanPanel();
  showActivity(true, 'Analizando tarea...');
  // Se resetea antes de cada turno para que el render en vivo (patchStream)
  // de esta respuesta nueva no herede por error los resultados del turno
  // anterior; se rellena de nuevo cuando llegue el evento 'done'.
  S.lastAppliedDiffs = [];

  // La busqueda de archivos relevantes y su lectura ahora ocurre
  // en el servidor, contra el clon REAL en disco — cada paso
  // real (leyendo tal archivo, ejecutando tal cosa) llega aqui
  // como un evento "log" del stream y se pinta en vivo.
  // El acumulador del stream se resetea por turno: el servidor nuevo
  // envia deltas incrementales que el frontend va sumando.
  S.streamAcc = '';
  const streamEl = mkStream();

  await runTurnWithStream(streamEl, callAI(msg, (text) => { patchStream(streamEl, text); }));

  S.busy = false;
  S.abortController = null;
  S.currentJobId = null;
  document.getElementById('sndbtn').disabled = !inp.value.trim();
  // La conversación ya tiene título y preview reales en el servidor.
  loadThreads();
}

// Final compartido de un turno con stream (lo usan send() y
// resumeJob()): pinta el resultado o el error en la burbuja y
// cierra el panel de actividad. Devuelve el texto final.
async function runTurnWithStream(streamEl, turnPromise) {
  let result = '';
  try {
    result = await turnPromise;
    finalStream(streamEl, result);
    updateLastLog('ok', 'Completado');
    finishActivity('Completado — actividad del turno');
    cvSetLive(false);
    detectEditsAndShowPushBanner(result);
  } catch (e) {
    if (e.name === 'AbortError') {
      finalStream(streamEl, result || '_Generacion detenida._');
    } else {
      finalStream(streamEl, `**Error:** ${e.message}`);
      updateLastLog('err', 'Error', e.message);
    }
    finishActivity('Terminado — actividad del turno');
    cvSetLive(false);
  }
  return result;
}

// ── Trabajos en curso (H2) ─────────────────────────────────────
// Lista los trabajos activos en la pantalla Tareas y deja volver
// a verlos: al tocar uno, la app abre su conversación y se
// re-engancha a su stream (los eventos guardados reconstruyen
// el texto desde el principio).
async function refreshJobsSection() {
  const title = document.getElementById('jobs-section-title');
  const el = document.getElementById('task-list-jobs');
  if (!el) return;
  let jobs = [];
  try {
    const resp = await authorizedApiFetch(`${API}/jobs`);
    if (resp.ok) {
      jobs = (await resp.json()).jobs.filter((j) => j.status === 'running' || j.status === 'queued');
    }
  } catch { /* sin sesión, la sección queda vacía */ }
  S.activeJobs = jobs;
  if (title) title.style.display = jobs.length ? '' : 'none';
  el.innerHTML = jobs.map((j) => `
    <div class="task-card" onclick="resumeJob('${esc(j.id)}')">
      <div class="task-icon" style="background:var(--accent)"><span class="job-pulse" aria-hidden="true"></span></div>
      <div class="task-info">
        <div class="task-name">${esc(String(j.message || 'Trabajo').slice(0, 60))}</div>
        <div class="task-desc">${j.status === 'queued' ? 'En cola — toca para verlo' : 'Trabajando — toca para verlo'}</div>
      </div>
      <svg class="task-arrow" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
    </div>`).join('');
  renderChatsList();
}

async function resumeJob(jobId) {
  if (S.busy) { showToast('El agente esta trabajando...'); return; }
  let job = null;
  try {
    const resp = await authorizedApiFetch(`${API}/jobs`);
    if (resp.ok) job = (await resp.json()).jobs.find((j) => j.id === jobId) || null;
  } catch {}
  if (!job) { showToast('No se encontró ese trabajo'); return; }
  if (job.status !== 'running' && job.status !== 'queued') {
    showToast('Ese trabajo ya terminó');
    refreshJobsSection();
    return;
  }
  S.busy = true;
  document.getElementById('sndbtn').disabled = true;
  S.currentJobId = jobId;
  S.currentThreadId = job.threadId || S.currentThreadId;
  S.abortController = new AbortController();
  if (job.threadId) await openThread(job.threadId, { force: true });
  // Si la conversación aún no trae el mensaje (trabajo creado
  // antes de guardarse), se pinta para no ver la respuesta sola.
  const lastMsg = [...document.querySelectorAll('#msgs .msg')].pop();
  const lastText = (lastMsg?.querySelector('.mbody')?.innerText || '').trim();
  if (lastText !== String(job.message || '').trim()) addMsg('me', job.message);
  clearActivityLog();
  resetComputerView();
  resetPlanPanel();
  showActivity(true, 'Analizando tarea...');
  showScreen('chat');
  S.streamAcc = '';
  const streamEl = mkStream();
  await runTurnWithStream(streamEl, attachToJob(jobId, (text) => { patchStream(streamEl, text); }, job.message));
  S.busy = false;
  S.abortController = null;
  S.currentJobId = null;
  document.getElementById('sndbtn').disabled = false;
  loadThreads();
  refreshJobsSection();
}

function doQuick(text) {
  if (S.busy) { showToast('El agente esta trabajando...'); return; }
  document.getElementById('inp').value = text;
  send();
}

// Igual que doQuick, pero deja el texto en el input SIN enviarlo,
// para prompts que terminan a medias (ej. "Busca en internet sobre: ")
// y necesitan que el usuario escriba el resto antes de mandar.
function doQuickPrefill(text) {
  if (S.busy) { showToast('El agente esta trabajando...'); return; }
  showScreen('chat');
  const inp = document.getElementById('inp');
  inp.value = text;
  inp.style.height = 'auto';
  inp.style.height = inp.scrollHeight + 'px';
  inp.focus();
  inp.setSelectionRange(text.length, text.length);
}

function clearChat() {
  if (S.busy) { showToast('El agente esta trabajando'); return; }
  S.currentThreadId = null; // la próxima conversación es un hilo nuevo
  document.getElementById('msgs').innerHTML = '';
  document.getElementById('empty').classList.remove('gone');
  showActivity(false);
  resetComputerView();
  hidePushBanner();
  S.history = [];
  S.pendingEdits = [];
  updateTasksBadge();
  clearActivityLog();
  resetPlanPanel();
  try { localStorage.removeItem(chatStoreKey()); } catch {}
  document.getElementById('context-bar')?.classList.remove('show');
  renderChatsList();
  showToast('Conversacion nueva');
}

// ═══════════════════════════════════════════
// CODEX v6 — plan visible, tests, deshacer, diff, AGENTS.md
// ═══════════════════════════════════════════
function setApplyMode(mode) {
  S.applyMode = mode === 'ask' ? 'ask' : 'auto';
  try { localStorage.setItem('da_apply_mode', S.applyMode); } catch {}
  syncSettingsUI();
  showToast(S.applyMode === 'ask'
    ? 'Modo Preguntar: revisas y aplicas cada diff tú'
    : 'Modo Auto: el agente aplica los diffs y los verifica');
}

function setFileLimit(v) {
  const n = parseInt(v, 10);
  if (![50, 100, 200].includes(n)) return;
  S.fileLimit = n;
  try { localStorage.setItem('da_file_limit', String(n)); } catch {}
  showToast(`El agente leerá hasta ${n} archivos por turno`);
}

// ── Plan del turno (evento SSE "plan") ──
function planStepIcon(status) {
  if (status === 'done') return `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`;
  if (status === 'error') return `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"/></svg>`;
  if (status === 'active' || status === 'in_progress' || status === 'running') return `<span class="plan-spin"></span>`;
  return `<span class="plan-dot"></span>`;
}

function renderPlan(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  S.planSteps = steps;
  const panel = document.getElementById('plan-panel');
  const list = document.getElementById('plan-steps');
  if (!panel || !list) return;
  if (!steps.length) { panel.classList.remove('show'); return; }
  panel.classList.add('show');
  list.innerHTML = steps.map((st) => {
    const status = String(st.status || 'pending');
    const cls = status === 'in_progress' || status === 'running' ? 'active' : status;
    return `<li class="plan-step ${esc(cls)}"><span class="plan-ic">${planStepIcon(status)}</span><span class="plan-label">${esc(st.label || st.id || 'Paso')}</span></li>`;
  }).join('');
}

function resetPlanPanel() {
  S.planSteps = [];
  S.lastVerify = null;
  const panel = document.getElementById('plan-panel');
  if (panel) panel.classList.remove('show');
  const list = document.getElementById('plan-steps');
  if (list) list.innerHTML = '';
  const chip = document.getElementById('verify-chip');
  if (chip) { chip.style.display = 'none'; chip.textContent = ''; }
}

// ── Chip de verificación con tests (evento SSE "verify") ──
function renderVerify(v) {
  if (!v) return;
  S.lastVerify = v;
  const chip = document.getElementById('verify-chip');
  const panel = document.getElementById('plan-panel');
  if (!chip) return;
  if (panel) panel.classList.add('show');
  chip.style.display = '';
  chip.className = 'verify-chip ' + (v.ok ? 'ok' : 'err');
  const bits = [`Comprobación ${v.ok ? 'superada' : 'con fallos'}`];
  if (v.summary) bits.push(String(v.summary));
  chip.innerHTML = `${v.ok ? checkSvg() : xSvg()} ${esc(bits.join(' · '))}`;
}

// ── Deshacer: vuelve al último checkpoint del workspace ──
async function doUndo() {
  if (!S.sessionId) { showToast('Sesión no lista todavía'); return; }
  if (S.busy) { showToast('El agente está trabajando...'); return; }
  const btn = document.getElementById('undo-btn');
  if (btn) btn.disabled = true;
  try {
    const resp = await apiFetch(`${API}/agent/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || data.reason || `Error ${resp.status}`);
    S.pendingEdits = [];
    updateTasksBadge();
    hidePushBanner();
    buzz([20, 50, 20]);
    showToast(data.message || 'Vuelto al estado anterior ✓');
  } catch (e) {
    showToast('No se pudo deshacer: ' + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Ver diff: modal cristal con archivos y diff completo ──
async function openDiffModal() {
  if (!S.sessionId) { showToast('Sesión no lista todavía'); return; }
  const modal = document.getElementById('diff-modal');
  const body = document.getElementById('diff-body');
  const filesEl = document.getElementById('diff-files');
  if (!modal || !body) return;
  body.textContent = 'Cargando…';
  if (filesEl) filesEl.innerHTML = '';
  modal.classList.add('open');
  try {
    const resp = await apiFetch(`${API}/agent/diff?sessionId=${encodeURIComponent(S.sessionId)}`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
    const files = Array.isArray(data.files) ? data.files : [];
    if (filesEl) {
      filesEl.innerHTML = files.length
        ? `<div class="diff-files-title">${files.length} archivo(s) con cambios</div>` + files.map((f) => `<div class="diff-file-row"><span class="diff-file-dot"></span><span>${esc(typeof f === 'string' ? f : (f.path || ''))}</span></div>`).join('')
        : '<div class="diff-files-title">Sin cambios por revisar</div>';
    }
    body.textContent = data.diff || 'Sin cambios.';
  } catch (e) {
    body.textContent = 'No se pudo cargar el cambio: ' + e.message;
  }
}
function closeDiffModal() { document.getElementById('diff-modal')?.classList.remove('open'); }

// ── Crear AGENTS.md del repo conectado ──
async function doCreateAgentsMd() {
  if (!S.sessionId) { showToast('Sesión no lista todavía'); return; }
  if (!S.repoData) { showToast('Conecta un repositorio primero'); return; }
  try {
    const resp = await apiFetch(`${API}/agent/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (data.exists) {
      showToast('Este proyecto ya tiene sus reglas');
    } else if (!resp.ok || data.ok === false) {
      throw new Error(data.error || `Error ${resp.status}`);
    } else {
      if (!S.pendingEdits.some((e) => e.path === 'AGENTS.md')) S.pendingEdits.push({ path: 'AGENTS.md' });
      updateTasksBadge();
      showToast('Reglas del proyecto creadas ✓');
    }
  } catch (e) {
    showToast('No se pudieron crear las reglas del proyecto: ' + e.message);
  }
}

// ── Repo reconectado al volver: preguntar antes de analizar ──
function showReconnectBanner(name) {
  const banner = document.getElementById('reconnect-banner');
  if (!banner) return;
  const nameEl = document.getElementById('rcb-name');
  if (nameEl) nameEl.textContent = `${name} reconectado`;
  banner.style.display = '';
}
function hideReconnectBanner() {
  const banner = document.getElementById('reconnect-banner');
  if (banner) banner.style.display = 'none';
}

// ═══════════════════════════════════════════
// CONVERSACIÓN PERSISTENTE (localStorage)
// Se guarda texto/rol/hora por cliente — sin HTML ni controles:
// al restaurar, los mensajes viejos no traen botones duplicados.
// ═══════════════════════════════════════════
let _restoringChat = false;
let _chatRestored = false;
function chatStoreKey() { return 'baro_chat_v1:' + (S.clientId || 'anon'); }

function saveChatHistory() {
  if (_restoringChat) return;
  try {
    const items = [...document.querySelectorAll('#msgs .msg')].map((div) => {
      const bodyEl = div.querySelector('.mbody');
      if (!bodyEl) return null;
      return {
        role: div.classList.contains('me') ? 'me' : 'ai',
        text: (bodyEl.innerText || bodyEl.textContent || '').trim(),
        time: div.querySelector('.mtime')?.textContent || '',
      };
    }).filter((it) => it && it.text).slice(-60);
    localStorage.setItem(chatStoreKey(), JSON.stringify(items));
  } catch {}
}

function restoreChatHistory() {
  if (_chatRestored) return;
  _chatRestored = true;
  let items = [];
  try { items = JSON.parse(localStorage.getItem(chatStoreKey()) || '[]'); } catch {}
  if (!Array.isArray(items) || !items.length) return;
  _restoringChat = true;
  for (const it of items) {
    if (!it || !it.text) continue;
    const div = addMsg(it.role === 'me' ? 'me' : 'ai', it.text);
    const bodyEl = div.querySelector('.mbody');
    if (bodyEl) bodyEl.innerHTML = `<p style="white-space:pre-wrap">${esc(it.role === 'ai' ? stripProtocolLines(it.text) : it.text)}</p>`;
    const timeEl = div.querySelector('.mtime');
    if (timeEl && it.time) timeEl.textContent = it.time;
    div.querySelector('.msg-actions')?.remove();
  }
  _restoringChat = false;
  scrollChatToBottom(false);
}

// ═══════════════════════════════════════════
// FILE PICKER (@archivo)
// ═══════════════════════════════════════════
function toggleFilePicker() {
  const picker = document.getElementById('file-picker');
  if (!picker) return;
  if (picker.classList.contains('open')) {
    closeFilePicker();
  } else {
    renderFilePicker('');
    picker.classList.add('open');
    setTimeout(() => document.getElementById('fp-search')?.focus(), 120);
  }
}

function closeFilePicker() {
  const picker = document.getElementById('file-picker');
  if (picker) picker.classList.remove('open');
  const search = document.getElementById('fp-search');
  if (search) search.value = '';
}

function filterFilePicker(q) {
  renderFilePicker(q.toLowerCase());
}

function renderFilePicker(q) {
  const list = document.getElementById('fp-list');
  if (!list) return;
  const files = S.files
    .map(f => f.path || f)
    .filter(p => !q || p.toLowerCase().includes(q))
    .slice(0, 60);

  if (files.length === 0) {
    list.innerHTML = '<div class="fp-empty">Sin resultados</div>';
    return;
  }

  list.innerHTML = files.map(path => {
    const parts = path.split('/');
    const name = parts.pop();
    const dir = parts.join('/');
    const ext = name.split('.').pop().toLowerCase();
    const colors = { js:'#f7df1e', ts:'#3178c6', jsx:'#61dafb', tsx:'#61dafb', py:'#3572a5', go:'#00add8', rs:'#dea584', css:'#563d7c', html:'#e34c26', json:'#292929', md:'#083fa1', vue:'#41b883' };
    const dot = colors[ext] || 'var(--border3)';
    return `<button class="fp-row" onclick="insertFileRef(${JSON.stringify(path)})">
      <span class="fp-dot" style="background:${dot}"></span>
      <span class="fp-name">${esc(name)}</span>
      ${dir ? `<span class="fp-dir">${esc(dir)}</span>` : ''}
    </button>`;
  }).join('');
}

function insertFileRef(path) {
  const inp = document.getElementById('inp');
  if (!inp) return;
  const filename = path.split('/').pop();
  const ref = `@${filename} `;
  const pos = inp.selectionStart;
  inp.value = inp.value.slice(0, pos) + ref + inp.value.slice(pos);
  inp.focus();
  inp.selectionStart = inp.selectionEnd = pos + ref.length;
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  document.getElementById('sndbtn').disabled = !inp.value.trim() || S.busy;
  closeFilePicker();
}

// ═══════════════════════════════════════════
// GITHUB DEVICE FLOW OAUTH
// ═══════════════════════════════════════════
let _devicePollTimer = null;
let _oauthRepos = null;
let _oauthUser = null;
let _selectedRepo = null;

async function startDeviceFlow() {
  const sheet = document.getElementById('device-flow-sheet');
  const body = document.getElementById('device-flow-body');
  if (!sheet || !body) return;

  body.innerHTML = `<div class="dfs-spinner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="28" height="28" class="spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div><p style="color:var(--text3);font-size:13px;margin-top:12px">Conectando con GitHub...</p>`;
  sheet.classList.add('open');

  try {
    const resp = await apiFetch(`${API}/auth/github/device`, { method: 'POST' });
    const data = await resp.json();
    if (data.error) { showDeviceFlowError(data.error); return; }

    const { device_code, user_code, verification_uri, expires_in, interval } = data;
    const pollMs = Math.max((interval || 5) * 1000, 5000);

    body.innerHTML = `
      <div style="margin-bottom:20px">
        <p style="font-size:13px;color:var(--text2);margin-bottom:16px">Abre el siguiente enlace e ingresa tu codigo:</p>
        <a href="${esc(verification_uri)}" target="_blank" rel="noopener" class="dfs-link">
          <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
          github.com/login/device
        </a>
        <div class="dfs-code">${esc(user_code)}</div>
        <button class="dfs-copy-btn" onclick="navigator.clipboard.writeText('${esc(user_code)}').then(()=>showToast('Codigo copiado'))">Copiar codigo</button>
      </div>
      <div class="dfs-status" id="dfs-status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" class="spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        Esperando autorizacion...
      </div>`;

    clearInterval(_devicePollTimer);
    _devicePollTimer = setInterval(() => pollDeviceFlow(device_code), pollMs);

    // Auto-expire
    setTimeout(() => {
      clearInterval(_devicePollTimer);
      const st = document.getElementById('dfs-status');
      if (st) st.innerHTML = '⚠️ Codigo expirado. Intenta de nuevo.';
    }, (expires_in || 900) * 1000);

  } catch (e) {
    showDeviceFlowError(e.message);
  }
}

async function pollDeviceFlow(deviceCode) {
  try {
    const resp = await apiFetch(`${API}/auth/github/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    const data = await resp.json();

    if (data.access_token) {
      clearInterval(_devicePollTimer);
      S.ghToken = data.access_token;
      localStorage.setItem('da_gh_token', data.access_token);
      closeDeviceFlowSheet();
      await loadGitHubRepos(data.access_token);
    } else if (data.error === 'slow_down') {
      // GitHub pide que reduzcamos el polling — esperar mas tiempo
    } else if (data.error && data.error !== 'authorization_pending') {
      clearInterval(_devicePollTimer);
      const st = document.getElementById('dfs-status');
      if (st) st.textContent = '❌ ' + (data.error_description || data.error);
    }
  } catch (_) { /* red error, retry en el proximo tick */ }
}

function cancelDeviceFlow() {
  clearInterval(_devicePollTimer);
  closeDeviceFlowSheet();
}

function closeDeviceFlowSheet() {
  document.getElementById('device-flow-sheet')?.classList.remove('open');
}

function showDeviceFlowError(msg) {
  const body = document.getElementById('device-flow-body');
  if (body) body.innerHTML = `<p style="color:var(--red);font-size:13px">❌ ${esc(msg)}</p><button class="btn btn-g" onclick="cancelDeviceFlow()" style="margin-top:14px;width:100%">Cerrar</button>`;
}

async function loadGitHubRepos(token) {
  openModal();
  const c = document.getElementById('step-content');
  if (c) c.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text3)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24" class="spin"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg><p style="margin-top:10px;font-size:13px">Cargando tus repositorios...</p></div>`;

  try {
    const resp = await apiFetch(`${API}/auth/github/repos`, {
      headers: { 'x-github-token': token },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Error cargando repos');
    _oauthRepos = data.repos;
    _oauthUser = data.user;
    renderRepoPicker('');
    updateModalStepTitle('Elige un repositorio');
  } catch (e) {
    const c2 = document.getElementById('step-content');
    if (c2) c2.innerHTML = `<p style="color:var(--red);font-size:13px;padding:8px 0">Error: ${esc(e.message)}</p>`;
  }
}

function updateModalStepTitle(title) {
  const el = document.getElementById('modal-title');
  if (el) el.textContent = title;
  const steps = document.getElementById('modal-steps');
  if (steps) steps.style.display = 'none';
}

function renderRepoPicker(q) {
  const c = document.getElementById('step-content');
  if (!c || !_oauthRepos) return;
  const lower = q.toLowerCase();
  const filtered = _oauthRepos
    .filter(r => !lower || r.full_name.toLowerCase().includes(lower) || (r.description || '').toLowerCase().includes(lower))
    .slice(0, 50);

  const langColors = { JavaScript:'#f7df1e', TypeScript:'#3178c6', Python:'#3572a5', Go:'#00add8', Rust:'#dea584', Ruby:'#cc342d', Java:'#b07219', 'C#':'#178600', PHP:'#4f5d95', Vue:'#41b883', Swift:'#fa7343', Kotlin:'#f18e33' };

  c.innerHTML = `
    <div class="rp-search-wrap">
      <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M10.68 11.74a6 6 0 01-7.922-8.982 6 6 0 018.982 7.922l3.04 3.04a.749.749 0 01-.326 1.275.749.749 0 01-.734-.215l-3.04-3.04zm-5.44-1.19a4.5 4.5 0 006.179-6.547 4.5 4.5 0 00-6.179 6.547z"/></svg>
      <input type="text" class="rp-search" placeholder="Buscar repositorio..." oninput="renderRepoPicker(this.value)" autocomplete="off" spellcheck="false" value="${esc(q)}">
    </div>
    <div class="rp-list">
      ${filtered.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">Sin resultados</div>' : filtered.map(r => {
        const lang = r.language || '';
        const dot = langColors[lang] || 'var(--border3)';
        const selected = _selectedRepo && _selectedRepo.full_name === r.full_name;
        return `<button class="rp-row${selected ? ' selected' : ''}" onclick='selectOAuthRepo(${JSON.stringify(r.full_name)}, ${JSON.stringify(r.default_branch || 'main')}, ${r.private})'>
          <div class="rp-row-name">${esc(r.name)}<span class="rp-owner">/${esc(r.owner?.login || '')}</span></div>
          <div class="rp-row-meta">
            ${lang ? `<span class="rp-lang-dot" style="background:${dot}"></span><span>${esc(lang)}</span>` : ''}
            ${r.private ? '<span class="rp-private">Privado</span>' : ''}
          </div>
          ${selected ? '<svg viewBox="0 0 16 16" fill="currentColor" width="16" height="16" style="color:var(--accent);flex-shrink:0"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>' : ''}
        </button>`;
      }).join('')}
    </div>`;
}

async function selectOAuthRepo(fullName, branch, isPrivate) {
  // Marcar visualmente el repo seleccionado
  _selectedRepo = { full_name: fullName, branch };
  S.branch = branch;
  S._pendingRepo = fullName;
  renderRepoPicker(document.querySelector('.rp-search')?.value || '');

  // Conectar directamente — sin paso extra de "Conectar"
  const btn = document.getElementById('modal-next');
  if (btn) { btn.disabled = true; btn.textContent = 'Conectando...'; }

  // Ocultar el picker y mostrar progreso
  const c = document.getElementById('step-content');
  if (c) c.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text3)">
    <div class="btn-spinner" style="margin:0 auto 12px;width:22px;height:22px;border-width:2.5px"></div>
    <div style="font-size:13px">Clonando <strong>${esc(fullName)}</strong>...</div>
  </div>`;

  try {
    await connectRepo(fullName);
    // Guardar en Firebase
    if (window.FB?.currentUser) {
      FB.saveLastRepo({ fullName, branch: S.branch, instructions: S.instructions || '' });
    }
    closeModal();
    showScreen('chat');
    autoAnalyze();
    showToast(fullName.split('/').pop() + ' conectado ✓');
  } catch(e) {
    showToast('Error conectando: ' + e.message);
    // Volver al picker para reintentar
    renderRepoPicker('');
    if (btn) { btn.disabled = false; btn.textContent = 'Continuar'; }
  }
}

// ═══════════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closePushModal(); closeFileViewer(); cancelDeviceFlow(); closeDiffModal(); }
  // v7: Ctrl/⌘+K es la paleta de comandos (ver sección App shell al final);
  // Nuevo chat por teclado pasa a Ctrl/⌘+Mayús+K para no borrar el chat
  // cada vez que se abre la paleta.
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); clearChat(); }
});

document.getElementById('modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});
document.getElementById('push-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('push-modal')) closePushModal();
});
document.getElementById('feedback-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('feedback-modal')) closeFeedbackModal();
});
document.getElementById('diff-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('diff-modal')) closeDiffModal();
});

document.getElementById('inp').addEventListener('input', autoGrow);

// ═══════════════════════════════════════════
// INIT
// initSession() se llama desde firebase-auth.js
// via window.onFirebaseAuthReady, una vez que el
// usuario ya esta autenticado y sus datos estan
// cargados en localStorage.
// ═══════════════════════════════════════════
loadSettings();
renderQuickCards();
restoreChatHistory();
// BARO v8 — en móvil la lista de chats es la pantalla de inicio,
// como en las apps de chat: avatar + nuevo chat + buscar.
syncUserAvatar();
if (window.matchMedia('(max-width: 768px)').matches) showScreen('chats');
// NO llamamos initSession() aqui: esperamos a Firebase Auth.

// ═══════════════════════════════════════════
// INTERACTIVIDAD MOVIL (v4)
// - Haptics suaves, chips rapidos, auto-grow del input desde el
//   primer render, boton flotante para volver abajo en el chat.
// ═══════════════════════════════════════════

// Vibracion tactil (solo movil; en desktop no hace nada).
function buzz(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern || 12);
  } catch (e) { /* noop */ }
}

// El textarea crece con el contenido. Se llama en cada 'input',
// al iniciar (para que el placeholder multilinea no se corte en
// pantallas angostas) y tras cada envio.
function autoGrow() {
  const inp = document.getElementById('inp');
  if (!inp) return;
  inp.style.height = 'auto';
  // Si el chat está oculto (p. ej. inicio móvil en la lista),
  // scrollHeight es 0: no pisar la altura con 0px.
  const h = Math.min(inp.scrollHeight, 140);
  if (h > 0) inp.style.height = h + 'px';
  document.getElementById('sndbtn').disabled = !inp.value.trim() || S.busy;
}

// ¿El usuario está leyendo cerca del final? Solo entonces el
// streaming puede acompañar hacia abajo (<320px, como el FAB).
function isNearBottom() {
  const sc = document.getElementById('chat-scroll');
  if (!sc) return true;
  return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 320;
}

function scrollChatToBottom(smooth) {
  const sc = document.getElementById('chat-scroll');
  if (!sc) return;
  sc.scrollTo({ top: sc.scrollHeight, behavior: smooth === false ? 'auto' : 'smooth' });
}

function updateScrollFab() {
  const sc = document.getElementById('chat-scroll');
  const fab = document.getElementById('scroll-fab');
  if (!sc || !fab) return;
  const away = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  fab.classList.toggle('show', away > 320);
}

/** @param {MouseEvent} event */
async function downloadProtectedFile(event) {
  const clickedElement = event.target instanceof Element ? event.target : null;
  const link = clickedElement?.closest('a[href]');
  if (!link) return;

  let targetUrl;
  try {
    targetUrl = new URL(link.href, window.location.href);
  } catch {
    return;
  }
  if (targetUrl.origin !== window.location.origin || targetUrl.pathname !== `${API}/files/download`) return;

  event.preventDefault();
  try {
    const response = await authorizedApiFetch(`${targetUrl.pathname}${targetUrl.search}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Error ${response.status}`);
    }
    const blobUrl = URL.createObjectURL(await response.blob());
    const downloadLink = document.createElement('a');
    downloadLink.href = blobUrl;
    downloadLink.download = targetUrl.searchParams.get('file')?.split('/').pop() || 'archivo';
    document.body.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), BLOB_URL_REVOKE_DELAY_MS);
  } catch (error) {
    showToast(`No se pudo descargar el archivo: ${error.message}`);
  }
}

document.addEventListener('click', downloadProtectedFile);

document.getElementById('chat-scroll').addEventListener('scroll', updateScrollFab, { passive: true });
window.addEventListener('resize', autoGrow);
autoGrow();

// Firebase llama esto cuando el usuario esta listo.
window.onFirebaseAuthReady = async function(user) {
  // Re-leer settings (Firebase pudo haber actualizado localStorage)
  loadSettings();
  syncSettingsUI();
  await initSession();
  restoreChatHistory();
};

async function initSession() {
  try {
    // Consulta configuración del servidor (Ollama, GitHub OAuth).
    const cfgResp = await authorizedApiFetch(`${API}/config`);
    S.serverConfig = await cfgResp.json();

    const sessResp = await authorizedApiFetch(`${API}/session`, { method: 'POST' });
    if (!sessResp.ok) throw new Error('No se pudo iniciar sesion con el servidor');
    const sess = await sessResp.json();
    S.sessionId = sess.sessionId;
    _initAttempts = 0;
    _initToastShown = false;
    updateStatusBadges();
    // Conversaciones reales del usuario (FASE 3).
    loadThreads();
  } catch (e) {
    // Si el backend no responde (por ejemplo, primer arranque en
    // Railway todavia construyendo), no rompemos la app: se
    // reintenta en segundo plano con espera creciente (3s, 6s,
    // 12s… hasta 30s) y UN solo aviso — antes el aviso salía
    // cada 3 segundos para siempre (v10 BUG 2/3).
    _initAttempts++;
    S.serverConfig = null;
    updateStatusBadges();
    if (!_initToastShown) {
      _initToastShown = true;
      showToast('No se pudo conectar con el servidor del agente. Reintentando...');
    }
    setTimeout(initSession, Math.min(30000, 3000 * 2 ** (_initAttempts - 1)));
    return;
  }

  // Mostrar el CTA de conectar repo en el empty state
  const ctaEl = document.getElementById('empty-connect-cta');
  if (ctaEl) ctaEl.style.display = '';

  // Auto-reconectar el ultimo repo guardado en Firebase
  if (window._fbLastRepo && window._fbLastRepo.fullName) {
    const { fullName, branch, instructions } = window._fbLastRepo;
    S.branch = branch || 'main';
    S.instructions = instructions || '';
    S._pendingRepo = fullName;
    const name = fullName.split('/').pop();
    showToast('Reconectando ' + name + '...');
    try {
      await connectRepo(fullName);
      showToast(name + ' conectado ✓');
      // Nada de disparar un análisis autónomo solo: se pregunta.
      if (!document.querySelector('#msgs .msg')) showReconnectBanner(name);
    } catch (e) {
      showToast('No se pudo reconectar el repo anterior');
      // No bloqueamos: el usuario puede conectar manualmente
    }
    return;
  }

}

// ═══════════════════════════════════════════
// BARO v7 — App shell: sidebar, paleta, atajos, inspector
// Solo chrome de aplicación; el chat y el agente no se tocan.
// ═══════════════════════════════════════════
const _isDesktopApp = () => window.matchMedia('(min-width: 900px)').matches;

function toggleSidebar() {
  if (_isDesktopApp()) {
    // Escritorio: colapsar la sidebar (se reabre con el mismo botón).
    const collapsed = document.body.classList.toggle('side-collapsed');
    try { localStorage.setItem('baro_sidebar_collapsed', collapsed ? 'true' : 'false'); } catch {}
  } else {
    // Móvil: la sidebar es un drawer sobre el contenido.
    document.body.classList.toggle('side-open');
  }
}
function closeSidebarDrawer() { document.body.classList.remove('side-open'); }
try {
  if (localStorage.getItem('baro_sidebar_collapsed') === 'true') document.body.classList.add('side-collapsed');
} catch {}

// Inspector: el rail lateral solo existe mientras el agente trabaja.
// Plan, Actividad o Vista de computadora muestran algo -> aparece;
// cuando terminan y se ocultan, el chat recupera todo el ancho.
function syncInspector() {
  const insp = document.getElementById('inspector');
  if (!insp) return;
  const anyShown = ['computer-view', 'plan-panel', 'activity'].some((id) => {
    const el = document.getElementById(id);
    return el && el.classList.contains('show');
  });
  insp.classList.toggle('has-panel', anyShown);
}
if (window.MutationObserver) {
  const _inspObs = new MutationObserver(syncInspector);
  ['computer-view', 'plan-panel', 'activity'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) _inspObs.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
}
syncInspector();
if (window.MutationObserver) {
  const _sbObs = new MutationObserver(syncStatusBar);
  const _dot = document.getElementById('conn-dot');
  if (_dot) _sbObs.observe(_dot, { attributes: true, attributeFilter: ['class'] });
}
syncStatusBar();


// BARO v7.1 — Barra de estado: refleja lo que ya pintan la sidebar
// y la barra de contexto, sin duplicar lógica de proveedor/modelo.
function syncStatusBar() {
  const t = (id) => document.getElementById(id)?.textContent || '';
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('sb-repo-txt', t('side-repo-name') || 'Sin repositorio');
  set('sb-model', t('side-model') || 'Listo para trabajar');
  const dot = document.getElementById('conn-dot');
  const ok = !!dot?.classList.contains('ok');
  const busy = !!dot?.classList.contains('busy');
  set('sb-conn', ok ? 'Conectado' : busy ? 'Trabajando…' : 'Sin conexión');
  document.getElementById('sb-dot')?.classList.toggle('ok', ok);
}
// ── Paleta de comandos (Ctrl/⌘+K) ──────────────────────────
// Todas las acciones ya existían; la paleta solo las reúne.
const _palIco = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/></svg>';
const PALETTE_ACTIONS = [
  { label: 'Nuevo chat', hint: 'Vacía la conversación · Ctrl/⌘+Mayús+K', run: () => { clearChat(); showScreen('chat'); } },
  { label: 'Ir a Chats', hint: 'Lista de conversaciones', run: () => showScreen('chats') },
  { label: 'Ir a Archivos', hint: 'Explorador del repo', run: () => showScreen('files') },
  { label: 'Ir a Tareas', hint: 'Rápidas y herramientas', run: () => showScreen('tasks') },
  { label: 'Ir a Configuración', hint: 'Conexiones y ajustes', run: () => showScreen('settings') },
  { label: 'Preguntar antes de aplicar', hint: 'Aplicar o preguntar primero', run: () => setApplyMode(S.applyMode === 'ask' ? 'auto' : 'ask') },
  { label: 'Conectar repo de GitHub', hint: 'Opcional', run: () => openModal() },
  { label: 'Ver cambios', hint: 'Cambios sin subir', run: () => openDiffModal() },
  { label: 'Volver al estado anterior', hint: 'Recupera el último estado guardado', run: () => doUndo() },
  { label: 'Exportar conversación', hint: 'Descarga el chat', run: () => exportConversation() },
  { label: 'Reportar un problema', hint: 'Enviar un bug', run: () => openFeedbackModal() },
  { label: 'Guardar configuración', hint: 'Y volver al chat', run: () => saveSettings() },
  { label: 'Mostrar u ocultar la barra lateral', hint: 'Ctrl/⌘+B', run: () => toggleSidebar() },
];
let _palSel = 0;
function palFiltered() {
  const q = (document.getElementById('pal-input')?.value || '').trim().toLowerCase();
  if (!q) return PALETTE_ACTIONS;
  return PALETTE_ACTIONS.filter((a) => (a.label + ' ' + a.hint).toLowerCase().includes(q));
}
function renderPalette() {
  const list = document.getElementById('pal-list');
  if (!list) return;
  const items = palFiltered();
  _palSel = Math.max(0, Math.min(_palSel, items.length - 1));
  list.innerHTML = items.length
    ? items.map((a, i) => `<button type="button" class="pal-item${i === _palSel ? ' sel' : ''}" role="option" aria-selected="${i === _palSel}" data-pal-idx="${i}">${_palIco}<span>${a.label}</span><span class="pal-hint">${a.hint || ''}</span></button>`).join('')
    : '<div class="pal-empty">Sin resultados para esa búsqueda.</div>';
  list.querySelectorAll('.pal-item').forEach((btn) => {
    btn.addEventListener('click', () => palRun(parseInt(btn.dataset.palIdx, 10)));
    btn.addEventListener('mousemove', () => {
      const i = parseInt(btn.dataset.palIdx, 10);
      if (i !== _palSel) { _palSel = i; renderPalette(); }
    });
  });
}
function openPalette() {
  const pal = document.getElementById('palette');
  if (!pal) return;
  closeSidebarDrawer();
  _palSel = 0;
  pal.classList.add('open');
  renderPalette();
  const inp = document.getElementById('pal-input');
  if (inp) { inp.value = ''; inp.focus(); renderPalette(); }
}
function closePalette() {
  document.getElementById('palette')?.classList.remove('open');
  document.getElementById('inp')?.focus();
}
function palRun(i) {
  const item = palFiltered()[i];
  if (!item) return;
  closePalette();
  item.run();
}
document.getElementById('pal-input')?.addEventListener('input', () => { _palSel = 0; renderPalette(); });
document.getElementById('pal-input')?.addEventListener('keydown', (e) => {
  const items = palFiltered();
  if (e.key === 'ArrowDown') { e.preventDefault(); _palSel = Math.min(_palSel + 1, items.length - 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); _palSel = Math.max(_palSel - 1, 0); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(_palSel); }
});
document.getElementById('palette')?.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'palette') closePalette();
});

// ── Atajos globales de app ─────────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'k' || e.key === 'K')) {
    // Ctrl/⌘+Mayús+K es Nuevo chat (handler viejo, más arriba); la
    // paleta solo responde al Ctrl/⌘+K sin Mayús.
    if (e.shiftKey) return;
    e.preventDefault();
    document.getElementById('palette')?.classList.contains('open') ? closePalette() : openPalette();
    return;
  }
  if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === 'Escape') {
    if (document.getElementById('palette')?.classList.contains('open')) { closePalette(); return; }
    closeSidebarDrawer();
  }
});

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
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
  serverConfig: null,    // { ollamaReady, ollamaModel, aiProvider, githubPreconfigured }
  lastAutoAppliedPaths: [],
  lastAppliedDiffs: [],
  MODELS: [
    'llama-3.3-70b-versatile',
    'deepseek-r1-distill-llama-70b',
    'mixtral-8x7b-32768',
    'llama3-8b-8192'
  ]
};

// Base de la API real. Mismo origen que sirve el frontend
// (el backend de Express sirve ambas cosas), asi que en
// Railway esto simplemente funciona sin configuracion extra.
const API = '/api';

// ═══════════════════════════════════════════
// FUENTE UNICA DE TAREAS RAPIDAS
// Antes esto estaba repetido a mano en dos pantallas
// distintas (#empty y #screen-tasks) con textos casi
// identicos que se podian desincronizar. Ahora vive UNA
// sola vez aqui y ambas pantallas se pintan desde esta
// misma lista con renderQuickCards()/renderTaskList().
// ═══════════════════════════════════════════
const QUICK_TASKS = {
  analysis: [
    {
      id: 'analyze', color: 'accent', title: 'Analizar repo', sub: 'Arquitectura y stack',
      icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/>',
      prompt: 'Analiza el repositorio completo: arquitectura, stack tecnologico, patrones de diseno usados, dependencias clave y top 5 problemas criticos con recomendaciones.',
    },
    {
      id: 'bugs', color: 'green', title: 'Detectar bugs', sub: 'Fix con diffs exactos',
      icon: '<path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/>',
      prompt: 'Detecta y corrige todos los bugs del proyecto. Para cada bug muestra: archivo, linea exacta, descripcion del problema y el diff preciso del fix.',
    },
    {
      id: 'security', color: 'amber', title: 'Seguridad OWASP', sub: 'Vulnerabilidades',
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      prompt: 'Haz auditoria de seguridad OWASP Top 10. Para cada vulnerabilidad: archivo, linea, riesgo y el codigo exacto de la correccion.',
    },
    {
      id: 'perf', color: 'purple', title: 'Rendimiento', sub: 'Optimizar velocidad',
      icon: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
      prompt: 'Optimiza el rendimiento: lazy loading, N+1 queries, bundle size, caching, async/await mal usado. Muestra el codigo optimizado.',
    },
  ],
  generate: [
    {
      id: 'tests', color: 'blue', title: 'Generar tests', sub: 'Unitarios e integracion',
      icon: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
      prompt: 'Genera tests unitarios completos para el proyecto con el framework adecuado. Incluye casos edge y mocks.',
    },
    {
      id: 'refactor', color: 'purple', title: 'Refactorizar', sub: 'SOLID, DRY, clean',
      icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
      prompt: 'Refactoriza el codigo aplicando SOLID, DRY, elimina codigo duplicado y mejora legibilidad. Muestra diffs exactos.',
    },
    {
      id: 'docs', color: 'green', title: 'Documentar', sub: 'README y JSDoc',
      icon: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
      prompt: 'Genera documentacion tecnica: README detallado, JSDoc para funciones clave y diagrama de arquitectura en texto.',
    },
    {
      id: 'modernize', color: 'amber', title: 'Modernizar', sub: 'Deps y patrones',
      icon: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
      prompt: 'Moderniza el proyecto: actualiza dependencias desactualizadas, migra codigo legacy y sugiere mejoras de TypeScript.',
    },
  ],
};

// Herramientas que van mas alla del codigo: busqueda web,
// Wikipedia, video e imagenes. Se muestran en su propia
// seccion (#quick-grid-tools) y disparan el mismo flujo de
// chat que las demas — la IA decide como usarlas y el
// progreso real se ve en vivo en el panel de actividad.
const TOOL_TASKS = [
  {
    id: 'websearch', color: 'blue', title: 'Buscar en internet', sub: 'Resultados en tiempo real',
    icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
    prompt: 'Busca en internet informacion actual y relevante sobre: ',
  },
  {
    id: 'wikipedia', color: 'green', title: 'Consultar Wikipedia', sub: 'Datos enciclopedicos',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20 15.3 15.3 0 010-20z"/>',
    prompt: 'Busca en Wikipedia informacion sobre: ',
  },
  {
    id: 'video', color: 'purple', title: 'Generar video con IA', sub: 'Hasta 10 min · 10/dia',
    icon: '<rect x="2" y="4" width="15" height="16" rx="2"/><path d="M17 9l5-3v12l-5-3"/>',
    prompt: 'Genera un video con esta descripcion: ',
  },
  {
    id: 'imageedit', color: 'amber', title: 'Editar/animar imagen', sub: 'Sube o pega una URL',
    icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
    prompt: 'Edita esta imagen: ',
  },
];

// Estas dos no son "prompts para la IA", son acciones directas
// de la app, asi que quedan separadas del set de arriba.
const SESSION_TASKS = [
  {
    id: 'export', color: 'green', title: 'Exportar conversacion', sub: 'Descargar como Markdown',
    icon: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    action: () => exportConversation(),
  },
  {
    id: 'newchat', color: 'red', title: 'Nueva conversacion', sub: 'Limpiar chat y empezar de cero',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    action: () => { clearChat(); showScreen('chat'); },
  },
];

function renderQuickCards() {
  const mount = (containerId, list, fn = 'doQuick') => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = list.map((t) => `
      <button class="qcard" onclick="${fn}(${JSON.stringify(t.prompt)})">
        <div class="qcard-icon ${t.color}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--${t.color})">${t.icon}</svg></div>
        <div class="qcard-title">${esc(t.title)}</div>
        <div class="qcard-sub">${esc(t.sub)}</div>
      </button>
    `).join('');
  };
  mount('quick-grid-analysis', QUICK_TASKS.analysis);
  mount('quick-grid-generate', QUICK_TASKS.generate);
  mount('quick-grid-tools', TOOL_TASKS, 'doQuickPrefill');
}

function renderTaskScreen() {
  const quickList = [...QUICK_TASKS.analysis, ...QUICK_TASKS.generate];
  const quickEl = document.getElementById('task-list-quick');
  if (quickEl) {
    quickEl.innerHTML = quickList.map((t) => `
      <div class="task-card" onclick='doQuick(${JSON.stringify(t.prompt)});showScreen("chat")'>
        <div class="task-icon" style="background:var(--${t.color === 'accent' ? 'accent-bg' : t.color === 'blue' ? 'bb' : t.color === 'purple' ? 'pb' : t.color === 'green' ? 'gb' : t.color === 'amber' ? 'ab' : 'accent-bg'})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" style="color:var(--${t.color})">${t.icon}</svg>
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
    toolsEl.innerHTML = TOOL_TASKS.map((t) => `
      <div class="task-card" onclick='doQuickPrefill(${JSON.stringify(t.prompt)})'>
        <div class="task-icon" style="background:var(--${t.color === 'blue' ? 'bb' : t.color === 'purple' ? 'pb' : t.color === 'green' ? 'gb' : t.color === 'amber' ? 'ab' : 'accent-bg'})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" style="color:var(--${t.color})">${t.icon}</svg>
        </div>
        <div class="task-info">
          <div class="task-name">${esc(t.title)}</div>
          <div class="task-desc">${esc(t.sub)}</div>
        </div>
        <svg class="task-arrow" viewBox="0 0 16 16" fill="currentColor"><path d="M6.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 010-1.06z"/></svg>
      </div>
    `).join('');
  }

  const sessionEl = document.getElementById('task-list-session');
  if (sessionEl) {
    sessionEl.innerHTML = SESSION_TASKS.map((t, i) => `
      <div class="task-card" onclick="SESSION_TASKS[${i}].action()">
        <div class="task-icon" style="background:var(--${t.color === 'green' ? 'gb' : 'rb'})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" style="color:var(--${t.color})">${t.icon}</svg>
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
  const screen = document.getElementById('screen-' + name);
  const nav = document.getElementById('nav-' + name);
  if (screen) screen.classList.add('active');
  if (nav) nav.classList.add('active');
  S.currentScreen = name;

  if (name === 'settings') syncSettingsUI();
  if (name === 'files') renderFileList();
  if (name === 'tasks') renderTaskScreen();
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
function loadSettings() {
  S.ghToken = localStorage.getItem('da_gh_token') || '';
  S.multiAgentEnabled = localStorage.getItem('da_multi_agent') !== 'false';
  S.planModeEnabled = localStorage.getItem('da_plan_mode') === 'true';
  S.fileLimit = parseInt(localStorage.getItem('da_file_limit') || '10');
  updateStatusBadges();
}

function syncSettingsUI() {
  const maToggle = document.getElementById('multiagent-toggle');
  if (maToggle) { if (S.multiAgentEnabled) maToggle.classList.add('on'); else maToggle.classList.remove('on'); }

  const pmToggle = document.getElementById('planmode-toggle');
  if (pmToggle) { if (S.planModeEnabled) pmToggle.classList.add('on'); else pmToggle.classList.remove('on'); }
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
}

function toggleSetting(name) {
  if (name === 'multiagent') {
    S.multiAgentEnabled = !S.multiAgentEnabled;
    const tog = document.getElementById('multiagent-toggle');
    if (S.multiAgentEnabled) tog.classList.add('on'); else tog.classList.remove('on');
  } else if (name === 'planmode') {
    S.planModeEnabled = !S.planModeEnabled;
    const tog = document.getElementById('planmode-toggle');
    if (S.planModeEnabled) tog.classList.add('on'); else tog.classList.remove('on');
  }
}

function saveSettings() {
  localStorage.setItem('da_multi_agent', S.multiAgentEnabled ? 'true' : 'false');
  localStorage.setItem('da_plan_mode', S.planModeEnabled ? 'true' : 'false');

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
    const response = await fetch(`${API}/feedback`, {
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

function updateStatusBadges() {
  const el = (id) => document.getElementById(id);
  const ollamaOk = !!S.serverConfig?.ollamaReady;

  el('ollama-ok-badge') && (el('ollama-ok-badge').style.display = ollamaOk ? '' : 'none');
  el('ollama-warn-badge') && (el('ollama-warn-badge').style.display = ollamaOk ? 'none' : '');
  const provider = S.serverConfig?.aiProvider || 'IA configurada';
  const model = S.serverConfig?.ollamaModel || 'modelo disponible';
  el('ollama-settings-sub') && (el('ollama-settings-sub').textContent = ollamaOk
    ? `${provider} activo — ${model}`
    : `${provider} no disponible todavía`);
  el('ai-model-label') && (el('ai-model-label').textContent = model);
  el('ai-model-sub') && (el('ai-model-sub').textContent = `${provider} · ejecución autónoma con verificación`);

  const ghOk = !!S.repoData;
  el('gh-settings-badge') && (el('gh-settings-badge').style.display = ghOk ? 'none' : '');
  el('gh-settings-badge-ok') && (el('gh-settings-badge-ok').style.display = ghOk ? '' : 'none');
  el('gh-settings-sub') && (el('gh-settings-sub').textContent = ghOk ? S.repoData.full_name : 'Conecta un repositorio');
  el('gh-dot') && (el('gh-dot').style.display = ghOk ? '' : 'none');
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

async function apiFetch(url, options, retry = true) {
  await ensureSession();
  const resp = await fetch(url, {
    ...options,
    body: options.body
      ? options.body.replace ? options.body.replace(/"sessionId":"[^"]*"/, `"sessionId":"${S.sessionId}"`) : options.body
      : undefined,
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

  let resp = await fetch(`${API}/repo/connect`, {
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
      resp = await fetch(`${API}/repo/connect`, {
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

  // Guardar ultimo repo en Firebase para auto-reconexion
  if (window.FB?.currentUser) {
    FB.saveLastRepo({ fullName: repo, branch: S.branch, instructions: S.instructions || '' });
  }
}

async function fetchFile(path) {
  if (!S.repoData || !S.sessionId) return null;
  try {
    const r = await fetch(`${API}/repo/file?sessionId=${encodeURIComponent(S.sessionId)}&path=${encodeURIComponent(path)}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data.content;
  } catch { return null; }
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
  if (!content) {
    document.getElementById('fv-code').innerHTML = '<div class="fv-loading">No se pudo cargar el archivo</div>';
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
  doQuick(`Analiza el archivo \`${S.currentFile}\` en detalle: que hace, patrones usados, bugs potenciales, problemas de calidad, y si encuentras algo muestra el diff exacto del cambio sugerido.`);
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
  document.getElementById('sndbtn').disabled = false;
}

function askAboutFile(path) {
  showScreen('chat');
  doQuick(`Analiza el archivo \`${path}\`: que hace, patrones usados, bugs potenciales y si encuentras algo muestra el diff exacto del cambio.`);
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
  document.getElementById('push-commit-msg').value = `fix: update via DevAgent ${new Date().toISOString().slice(0,10)}`;
  document.getElementById('push-branch').value = S.branch;
  document.getElementById('push-result').style.display = 'none';
  document.getElementById('push-confirm-btn').disabled = false;
  document.getElementById('push-confirm-btn').textContent = 'Push';

  const list = document.getElementById('push-files-list');
  if (S.pendingEdits.length) {
    list.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px">${S.pendingEdits.length} archivos para commit</div>` +
      S.pendingEdits.map(e => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0"></div>
        <span style="font-family:var(--mono);color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.path)}</span>
      </div>`).join('');
  } else {
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:8px 0;line-height:1.6">Aun no hay cambios aplicados. Toca "Aplicar" en un bloque de diff del chat para escribirlo de verdad en el archivo, y aparecera aqui.</div>`;
  }
  document.getElementById('push-modal').classList.add('open');
}
function closePushModal() { document.getElementById('push-modal').classList.remove('open'); }

async function confirmPush() {
  if (!S.sessionId) { showToast('Sesion no lista, intenta de nuevo'); return; }
  if (!S.ghToken && !S.serverConfig?.githubPreconfigured) { showToast('Configura tu GitHub Token'); return; }
  if (!S.repoData) { showToast('No hay repo conectado'); return; }

  const msg = document.getElementById('push-commit-msg').value.trim() || 'update via DevAgent';
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
    const resp = await fetch(`${API}/agent/push`, {
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
      btn.textContent = 'Push';
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

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════
function exportConversation() {
  const msgs = document.getElementById('msgs');
  if (!msgs?.children.length) { showToast('No hay mensajes para exportar'); return; }
  let md = `# DevAgent — Conversacion\n\n`;
  if (S.repoData) md += `**Repo:** ${S.repoData.full_name}\n`;
  md += `**Fecha:** ${new Date().toLocaleString('es')}\n\n---\n\n`;
  [...msgs.children].forEach(msg => {
    const isUser = msg.classList.contains('me');
    const body = msg.querySelector('.mbody');
    if (!body) return;
    md += `**${isUser ? 'Tu' : 'DevAgent'}:**\n\n${body.innerText}\n\n---\n\n`;
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
    if (text) document.getElementById('act-head-txt').textContent = text;
    setBusy(true);
  } else {
    el.classList.remove('show');
    setBusy(false);
  }
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
    run:`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>`,
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
}

function cvBrowser(payload) {
  if (_cvMode !== 'browser') { _cvMode = 'browser'; cvSetBody(''); }

  if (payload.action === 'search') {
    const engineLabel = payload.engine === 'wikipedia' ? 'es.wikipedia.org' : 'google.com/search';
    const engineUrl = payload.engine === 'wikipedia'
      ? `es.wikipedia.org/w/index.php?search=${encodeURIComponent(payload.query)}`
      : `google.com/search?q=${encodeURIComponent(payload.query)}`;
    cvSetAddress(engineUrl, true);
    cvSetBody(`
      <div class="cv-search-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><circle cx="7" cy="7" r="5.5"/><path d="M14 14l-3-3"/></svg>
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
    cvSetAddress(`terminal — ${payload.command}`, true);
    term.insertAdjacentHTML('beforeend', `<div class="cv-term-line cv-term-cmd">${esc(payload.command)}</div>`);
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
    wrap.innerHTML = `<div class="cv-file-tab">${fileSvg}<span>${esc(payload.path || '')}</span><span class="cv-file-status">${ok ? `guardado · ${payload.bytes ?? 0} bytes` : 'no aplicado'}</span></div>
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
  const tokEl = document.getElementById('ctx-tokens');

  if (tokens > 0) bar?.classList.add('show');
  if (fill) { fill.style.width = pct + '%'; fill.className = 'ctx-fill' + (pct > 90 ? ' full' : pct > 70 ? ' warn' : ''); }
  if (pctEl) pctEl.textContent = pct + '%';
  if (tokEl) tokEl.textContent = tokens.toLocaleString() + ' tokens';
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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  const title = titleMatch ? titleMatch[1].replace(/^"|"$/g, '') : 'Wikipedia';
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
      <div class="media-card-badge">Wikipedia</div>
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
  const remainingMatch = raw.match(/Videos restantes hoy: (\d+)/);
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
      ${remainingMatch ? `<span>${remainingMatch[1]} video(s) restantes hoy</span>` : ''}
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

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/^[-•] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => `<ul class="mbody">${m}</ul>`);
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/^---+$/gm, '<hr>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^(?!<[hulo]|<li|<hr|<div|<pre|<ul|<block|\u0000MEDIA_BLOCK_)(.+)$/gm, '<p>$1</p>');
  s = s.replace(/<p><\/p>/g, '');

  // Sustituimos los marcadores por las tarjetas HTML reales, ahora
  // que el markdown alrededor ya esta resuelto.
  s = s.replace(/\u0000MEDIA_BLOCK_(\d+)\u0000/g, (_, i) => mediaBlocks[Number(i)] || '');

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
  if (!rawDiff) { showToast('No se encontro el contenido del diff'); return; }
  if (!S.sessionId || !S.repoData) { showToast('Conecta un repositorio primero'); return; }

  const originalLabel = btn.innerHTML;
  btn.innerHTML = '<div class="btn-spinner"></div> Aplicando...';
  btn.disabled = true;

  try {
    const resp = await fetch(`${API}/agent/apply-diff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId, diff: rawDiff }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);

    const failed = (data.results || []).filter((r) => !r.applied);
    const applied = (data.results || []).filter((r) => r.applied);

    if (applied.length) {
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
      showToast(failure.reason || 'El diff no coincide con el archivo actual');
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
    showToast('Error aplicando el diff: ' + e.message);
  }
}

function rejectDiff(btn) {
  const block = btn.closest('.cblock');
  if (block) { block.style.opacity = '0.3'; block.style.pointerEvents = 'none'; }
  showToast('Diff descartado');
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
  div.innerHTML = `<div class="tool-card-head" onclick="this.closest('.tool-card').classList.toggle('open')">
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
    `;
  } else {
    div.innerHTML = `
      <div class="msg-meta">
        <div class="av ai">DA</div>
        <span class="mname">DevAgent</span>
        <span class="mtime">${now()}</span>
      </div>
      <div class="mbubble"><div class="mbody">${md(text)}</div></div>
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
  div.scrollIntoView({ behavior:'smooth', block:'end' });
  return div;
}

function copyMsg(btn) {
  const body = btn.closest('.msg')?.querySelector('.mbody');
  if (!body) return;
  navigator.clipboard.writeText(body.innerText || body.textContent).then(() => showToast('Copiado'));
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
  div.className = 'msg ai';
  div.innerHTML = `
    <div class="msg-meta">
      <div class="av ai">DA</div>
      <span class="mname">DevAgent</span>
      <span class="mtime">${now()}</span>
    </div>
    <div class="mbubble"><div class="mbody"><div class="typing-indicator"><div class="dots"><span></span><span></span><span></span></div> Generando...</div></div></div>
  `;
  msgs.appendChild(div);
  div.scrollIntoView({ behavior:'smooth', block:'end' });
  return div;
}

function patchStream(div, text) {
  const body = div.querySelector('.mbody');
  if (!body) return;
  body.innerHTML = md(text) + '<span class="scursor"></span>';
  div.scrollIntoView({ behavior:'smooth', block:'end' });
}

function finalStream(div, text) {
  const body = div.querySelector('.mbody');
  if (!body) return;
  body.innerHTML = md(text);
  // Add action buttons
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.innerHTML = `
    <button class="ma-btn" onclick="copyMsg(this)">${copySvg()} Copiar</button>
    <button class="ma-btn" onclick="regen(this)"><svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg> Regenerar</button>
  `;
  div.appendChild(actions);
}

// ═══════════════════════════════════════════
// AI — via backend real (SSE)
// El prompt, la busqueda de archivos relevantes y la lectura
// de su contenido ahora ocurren en el servidor, contra el
// clon real en disco — no aqui. Esta funcion solo abre el
// stream, reenvia los logs de actividad al panel visual y
// devuelve el texto final.
// ═══════════════════════════════════════════
async function callAI(msg, onStream) {
  await ensureSession();

  S.abortController = new AbortController();

  const makeBody = () => JSON.stringify({
    sessionId: S.sessionId,
    message: msg,
    planMode: S.planModeEnabled,
    fileLimit: S.fileLimit,
    autoApply: true,
  });

  let resp = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
      resp = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: S.abortController.signal,
        body: makeBody(),
      });
    }
  }

  if (!resp.ok || !resp.body) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Error ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalText = '';

  while (true) {
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

      if (eventName === 'log') {
        // Actividad real del servidor (leyendo archivos reales,
        // ejecutando, etc.) reflejada en el panel de actividad.
        log(payload.type, payload.title, payload.detail || '');
      } else if (eventName === 'computer') {
        // Mismo origen que 'log' (eventos reales del servidor), pero
        // renderizado como una ventana de navegador/terminal/editor
        // en vivo en vez de una linea de texto.
        renderComputerEvent(payload);
      } else if (eventName === 'delta') {
        finalText = payload.text;
        if (onStream) onStream(finalText);
      } else if (eventName === 'error') {
        throw new Error(payload.error);
      } else if (eventName === 'done') {
        finalText = payload.text ?? finalText;
        S.lastAutoAppliedPaths = Array.isArray(payload.autoAppliedPaths) ? payload.autoAppliedPaths : [];
        S.lastAppliedDiffs = Array.isArray(payload.appliedDiffs) ? payload.appliedDiffs : [];
        for (const path of S.lastAutoAppliedPaths) {
          if (!S.pendingEdits.some((edit) => edit.path === path)) S.pendingEdits.push({ path });
        }
        updateTasksBadge();
      }
    }
  }

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
  const msg = `He conectado **${S.repoData.full_name}** en la rama **${S.branch}**. Empieza ahora una revisión autónoma del proyecto: inspecciona su estructura y manifiestos, identifica el stack, ejecuta las comprobaciones y tests seguros disponibles, corrige los bugs importantes que puedas confirmar, aplica los cambios, vuelve a verificar y termina con un resumen de lo que hiciste y lo que necesita atención. No me pidas confirmación para leer, editar o ejecutar validaciones; solo deja el push manual como acción explícita.`;
  doQuick(msg);
}

// ═══════════════════════════════════════════
// STOP / SEND
// ═══════════════════════════════════════════
function stopGeneration() {
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

  S.busy = true;
  inp.value = '';
  inp.style.height = 'auto';
  document.getElementById('sndbtn').disabled = true;

  addMsg('me', msg);
  clearActivityLog();
  resetComputerView();
  showActivity(true, 'Analizando tarea...');
  // Se resetea antes de cada turno para que el render en vivo (patchStream)
  // de esta respuesta nueva no herede por error los resultados del turno
  // anterior; se rellena de nuevo cuando llegue el evento 'done'.
  S.lastAppliedDiffs = [];

  // La busqueda de archivos relevantes y su lectura ahora ocurre
  // en el servidor, contra el clon REAL en disco — cada paso
  // real (leyendo tal archivo, ejecutando tal cosa) llega aqui
  // como un evento "log" del stream y se pinta en vivo.
  const streamEl = mkStream();
  let result = '';

  try {
    result = await callAI(msg, (text) => { patchStream(streamEl, text); });
    finalStream(streamEl, result);
    updateLastLog('ok', 'Completado');
    showActivity(false);
    cvSetLive(false);
    cvHideDelayed();
    detectEditsAndShowPushBanner(result);
  } catch(e) {
    if (e.name === 'AbortError') {
      finalStream(streamEl, result || '_Generacion detenida._');
    } else {
      finalStream(streamEl, `**Error:** ${e.message}`);
      updateLastLog('err', 'Error', e.message);
    }
    showActivity(false);
    cvSetLive(false);
    cvHideDelayed();
  }

  S.busy = false;
  S.abortController = null;
  document.getElementById('sndbtn').disabled = false;
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
  document.getElementById('msgs').innerHTML = '';
  document.getElementById('empty').classList.remove('gone');
  showActivity(false);
  resetComputerView();
  hidePushBanner();
  S.history = [];
  S.pendingEdits = [];
  updateTasksBadge();
  clearActivityLog();
  document.getElementById('context-bar')?.classList.remove('show');
  showToast('Conversacion nueva');
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
    const resp = await fetch(`${API}/auth/github/device`, { method: 'POST' });
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
    const resp = await fetch(`${API}/auth/github/poll`, {
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
    const resp = await fetch(`${API}/auth/github/repos`, {
      headers: { Authorization: `Bearer ${token}` },
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
  if (e.key === 'Escape') { closeModal(); closePushModal(); closeFileViewer(); cancelDeviceFlow(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); clearChat(); }
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

document.getElementById('inp').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  document.getElementById('sndbtn').disabled = !this.value.trim() || S.busy;
});

// ═══════════════════════════════════════════
// INIT
// initSession() se llama desde firebase-auth.js
// via window.onFirebaseAuthReady, una vez que el
// usuario ya esta autenticado y sus datos estan
// cargados en localStorage.
// ═══════════════════════════════════════════
loadSettings();
renderQuickCards();
// NO llamamos initSession() aqui: esperamos a Firebase Auth.

// Firebase llama esto cuando el usuario esta listo.
window.onFirebaseAuthReady = async function(user) {
  // Re-leer settings (Firebase pudo haber actualizado localStorage)
  loadSettings();
  syncSettingsUI();
  await initSession();
};

async function initSession() {
  try {
    // Consulta configuración del servidor (Ollama, GitHub OAuth).
    const cfgResp = await fetch(`${API}/config`);
    S.serverConfig = await cfgResp.json();

    const sessResp = await fetch(`${API}/session`, { method: 'POST' });
    if (!sessResp.ok) throw new Error('No se pudo iniciar sesion con el servidor');
    const sess = await sessResp.json();
    S.sessionId = sess.sessionId;
    updateStatusBadges();
  } catch (e) {
    // Si el backend no responde (por ejemplo, primer arranque en
    // Railway todavia construyendo), no rompemos la app: se
    // reintenta la proxima vez que el usuario intente algo real.
    showToast('No se pudo conectar con el servidor del agente. Reintentando...');
    setTimeout(initSession, 3000);
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
    } catch (e) {
      showToast('No se pudo reconectar el repo anterior');
      // No bloqueamos: el usuario puede conectar manualmente
    }
    return;
  }

}

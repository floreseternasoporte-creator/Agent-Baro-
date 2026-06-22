const app = document.getElementById('app');
const toastRoot = document.getElementById('toast');

const STORAGE_KEY = 'devagent.grok.manus.v1';

const templates = {
  import: "I'm importing your repository into Bolt. This may take a moment as I set everything up. Once it's ready, you'll be able to explore and interact with your code.",
  scan: "I'll search through the repository first, map the files, then make the safest code changes instead of guessing.",
  manus: "I'll run this like an autonomous agent: plan, research, execute, verify, and summarize what changed."
};

const defaultChats = [
  {
    id: crypto.randomUUID(),
    title: 'Importar repo en Bolt',
    createdAt: Date.now(),
    files: [
      { path: 'index.html', status: 'M' },
      { path: 'styles.css', status: 'M' },
      { path: 'app.js', status: 'A' }
    ],
    messages: [
      { role: 'assistant', content: templates.import, plan: {
        title: 'Import the GitHub repository into Bolt',
        status: 'done',
        steps: [
          { label: 'Connect to GitHub repository', state: 'done' },
          { label: 'Read project structure and dependencies', state: 'done' },
          { label: 'Prepare interactive workspace', state: 'done' }
        ]
      }},
      { role: 'assistant', content: 'Plan completed' }
    ]
  }
];

let state = loadState();
let activeId = state.activeId || state.chats[0].id;
let isRunning = false;

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (parsed?.chats?.length) return parsed;
  } catch {}
  return { activeId: defaultChats[0].id, chats: defaultChats, sidebarOpen: true, filesOpen: true };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, activeId }));
}

function activeChat() {
  return state.chats.find(chat => chat.id === activeId) || state.chats[0];
}

function icon(name) {
  const icons = {
    menu: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    files: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    send: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 14-7-7 14-2-5-5-2z"/></svg>',
    stop: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.8-2.8.1-.1A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1L7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
  };
  return icons[name] || '';
}

function render() {
  const chat = activeChat();
  app.innerHTML = `
    <aside class="sidebar ${state.sidebarOpen ? 'mobile-open' : 'collapsed'}">
      <div class="sidebar-header"><div class="logo"><div class="logo-mark">G</div><span>DevAgent</span></div></div>
      <button class="new-chat-btn" data-action="new">${icon('plus')} Nuevo trabajo</button>
      <div class="chats-list"><div class="chat-section-label">Workspaces</div>${state.chats.map(c => `
        <div class="chat-item ${c.id === activeId ? 'active' : ''}" data-chat="${c.id}"><span>●</span><span class="chat-item-title">${escapeHtml(c.title)}</span><span class="chat-item-del" data-delete="${c.id}">×</span></div>`).join('')}</div>
      <div class="sidebar-footer"><button data-template="scan">Repo scan</button><button data-template="manus">Manus mode</button></div>
    </aside>
    <main class="main">
      <header class="topbar"><button class="icon-btn" data-action="sidebar">${icon('menu')}</button><div class="topbar-title">${escapeHtml(chat.title)}</div><div class="repo-badge"><span class="dot"></span> /workspace/Agent-Baro-</div><button class="icon-btn" data-action="files">${icon('files')}</button></header>
      <section class="messages"><div class="messages-inner">${chat.messages.length ? chat.messages.map(renderMessage).join('') : renderEmpty()}</div></section>
      <div class="push-banner"><span class="push-banner-icon">✦</span><div class="push-banner-text"><strong>Agentic workflow:</strong> plan → search repo → edit code → verify. <span class="push-banner-count">${chat.files.length}</span> files tracked.</div><button class="btn btn-primary btn-sm" data-action="simulate">Run plan</button></div>
      <div class="composer-wrap"><div class="composer"><textarea id="prompt" placeholder="Pide un cambio, importa un repo o activa Manus mode..." rows="1"></textarea><div class="composer-bar"><div class="composer-bar-left"><span class="composer-hint">Enter para enviar · Shift+Enter nueva línea</span></div><button class="send-btn ${isRunning ? 'stop-btn' : ''}" data-action="send">${isRunning ? icon('stop') : icon('send')}</button></div></div></div>
    </main>
    <aside class="files-panel ${state.filesOpen ? '' : 'collapsed'}"><div class="files-header">${icon('files')} Cambios del repo</div><div class="files-list">${chat.files.length ? chat.files.map(f => `<div class="file-row"><span class="file-badge ${f.status}">${f.status}</span>${escapeHtml(f.path)}</div>`).join('') : '<div class="files-empty">Aún no hay cambios.</div>'}</div></aside>`;
  bindEvents();
  document.querySelector('.messages')?.scrollTo({ top: 99999 });
}

function renderEmpty() {
  return `<div class="empty-state"><h1>¿Qué quieres construir?</h1><p>Un espacio tipo Grok/Manus para automatizar planes, búsquedas de repositorio y edición de código.</p><div class="suggestion-grid"><button class="suggestion" data-template="import"><strong>Importar repositorio</strong>Preparar workspace como Bolt.</button><button class="suggestion" data-template="scan"><strong>Buscar en el repo</strong>Mapear archivos antes de editar.</button><button class="suggestion" data-template="manus"><strong>Manus mode</strong>Planificar, ejecutar y verificar.</button><button class="suggestion" data-template="custom"><strong>Arreglar UI</strong>Ordenar estilos fuera de lugar.</button></div></div>`;
}

function renderMessage(message) {
  return `<article class="msg ${message.role}"><div class="msg-avatar">${message.role === 'user' ? 'Tú' : 'AI'}</div><div class="msg-body"><div class="msg-role">${message.role === 'user' ? 'Usuario' : 'DevAgent'}</div><div class="msg-content">${formatContent(message.content)}${message.plan ? renderPlan(message.plan) : ''}</div></div></article>`;
}

function renderPlan(plan) {
  return `<div class="plan-card"><div class="plan-header"><span class="plan-icon ${plan.status === 'done' ? 'done' : 'spinning'}">${plan.status === 'done' ? '✓' : '◌'}</span><div class="plan-title">${escapeHtml(plan.title)}</div><span class="plan-status ${plan.status}">${plan.status === 'done' ? 'completed' : plan.status}</span></div><div class="plan-steps">${plan.steps.map(step => `<div class="plan-step ${step.state}"><span class="plan-step-label">${escapeHtml(step.label)}</span><span class="plan-step-icon">${step.state === 'done' ? '✓' : '•'}</span></div>`).join('')}</div></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-action="sidebar"]').forEach(el => el.onclick = () => toggle('sidebarOpen'));
  document.querySelectorAll('[data-action="files"]').forEach(el => el.onclick = () => toggle('filesOpen'));
  document.querySelector('[data-action="new"]')?.addEventListener('click', newChat);
  document.querySelector('[data-action="send"]')?.addEventListener('click', sendPrompt);
  document.querySelector('[data-action="simulate"]')?.addEventListener('click', runPlan);
  document.querySelectorAll('[data-chat]').forEach(el => el.onclick = () => { activeId = el.dataset.chat; saveState(); render(); });
  document.querySelectorAll('[data-delete]').forEach(el => el.onclick = (event) => { event.stopPropagation(); deleteChat(el.dataset.delete); });
  document.querySelectorAll('[data-template]').forEach(el => el.onclick = () => applyTemplate(el.dataset.template));
  document.getElementById('prompt')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPrompt(); }
  });
}

function toggle(key) { state[key] = !state[key]; saveState(); render(); }
function newChat() { const chat = { id: crypto.randomUUID(), title: 'Nuevo trabajo', createdAt: Date.now(), files: [], messages: [] }; state.chats.unshift(chat); activeId = chat.id; saveState(); render(); }
function deleteChat(id) { if (state.chats.length === 1) return toast('No puedes borrar el último chat', 'error'); state.chats = state.chats.filter(c => c.id !== id); if (activeId === id) activeId = state.chats[0].id; saveState(); render(); }
function applyTemplate(key) { const prompt = document.getElementById('prompt'); if (!prompt) return; prompt.value = templates[key] || 'Arregla la interfaz y organiza los componentes que están fuera de lugar.'; prompt.focus(); }

function sendPrompt() {
  if (isRunning) { isRunning = false; toast('Ejecución detenida', 'error'); render(); return; }
  const prompt = document.getElementById('prompt');
  const text = prompt?.value.trim();
  if (!text) return toast('Escribe una instrucción primero', 'error');
  const chat = activeChat();
  chat.messages.push({ role: 'user', content: text });
  chat.title = text.slice(0, 42);
  prompt.value = '';
  saveState();
  render();
  runPlan();
}

function runPlan() {
  const chat = activeChat();
  isRunning = true;
  chat.messages.push({ role: 'assistant', content: 'Voy a trabajar con un flujo automatizado: primero entiendo el objetivo, luego busco en el repositorio, aplico cambios y verifico el resultado.', plan: {
    title: 'Autonomous repo workflow', status: 'running', steps: [
      { label: 'Entender objetivo y restricciones', state: 'done' },
      { label: 'Buscar archivos relevantes en el repositorio', state: 'active' },
      { label: 'Editar código de forma segura', state: 'todo' },
      { label: 'Verificar UI y guardar resumen', state: 'todo' }
    ]
  }});
  saveState();
  render();
  setTimeout(() => {
    const last = chat.messages.at(-1);
    if (last?.plan) {
      last.plan.status = 'done';
      last.plan.steps = last.plan.steps.map(step => ({ ...step, state: 'done' }));
      chat.messages.push({ role: 'assistant', content: 'Plan completed. El patrón queda alineado con Manus: planificación visible, búsqueda explícita, ejecución por pasos, panel de archivos y verificación final.' });
    }
    isRunning = false;
    saveState();
    render();
  }, 900);
}

function toast(message, type = 'success') {
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.textContent = message;
  toastRoot.appendChild(item);
  setTimeout(() => item.remove(), 2400);
}

function formatContent(value) {
  return escapeHtml(value).split('\n').map(line => `<p>${line}</p>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

render();

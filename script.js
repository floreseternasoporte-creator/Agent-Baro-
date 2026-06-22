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
  MODELS: [
    'llama-3.3-70b-versatile',
    'deepseek-r1-distill-llama-70b',
    'mixtral-8x7b-32768',
    'llama3-8b-8192'
  ]
};

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
}

// ═══════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════
function loadSettings() {
  S.groqKey = localStorage.getItem('da_groq_key') || '';
  S.ghToken = localStorage.getItem('da_gh_token') || '';
  S.model = localStorage.getItem('da_model') || 'llama-3.3-70b-versatile';
  S.multiAgentEnabled = localStorage.getItem('da_multi_agent') !== 'false';
  S.planModeEnabled = localStorage.getItem('da_plan_mode') === 'true';
  S.fileLimit = parseInt(localStorage.getItem('da_file_limit') || '10');
  updateStatusBadges();
  updateModelBtn();
}

function syncSettingsUI() {
  document.getElementById('set-groq').value = S.groqKey || '';
  document.getElementById('set-ghtoken').value = S.ghToken || '';

  // Model selection
  const modelNames = ['llama-3.3-70b-versatile','deepseek-r1-distill-llama-70b','mixtral-8x7b-32768','llama3-8b-8192'];
  modelNames.forEach((m, i) => {
    const check = document.getElementById('model-check-' + i);
    if (check) check.style.display = m === S.model ? '' : 'none';
  });

  const maToggle = document.getElementById('multiagent-toggle');
  if (maToggle) { if (S.multiAgentEnabled) maToggle.classList.add('on'); else maToggle.classList.remove('on'); }

  const pmToggle = document.getElementById('planmode-toggle');
  if (pmToggle) { if (S.planModeEnabled) pmToggle.classList.add('on'); else pmToggle.classList.remove('on'); }
}

function selectModel(model) {
  S.model = model;
  const modelNames = ['llama-3.3-70b-versatile','deepseek-r1-distill-llama-70b','mixtral-8x7b-32768','llama3-8b-8192'];
  modelNames.forEach((m, i) => {
    const check = document.getElementById('model-check-' + i);
    if (check) check.style.display = m === model ? '' : 'none';
  });
  updateModelBtn();
  showToast('Modelo: ' + model.replace('-versatile','').replace('-distill-llama-70b',' R1'));
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
  const key = document.getElementById('set-groq').value.trim();
  const tok = document.getElementById('set-ghtoken').value.trim();

  if (!key) { showToast('La API key de Groq es requerida'); return; }

  localStorage.setItem('da_groq_key', key);
  localStorage.setItem('da_gh_token', tok);
  localStorage.setItem('da_model', S.model);
  localStorage.setItem('da_multi_agent', S.multiAgentEnabled ? 'true' : 'false');
  localStorage.setItem('da_plan_mode', S.planModeEnabled ? 'true' : 'false');

  S.groqKey = key;
  S.ghToken = tok;

  updateStatusBadges();
  updateModelBtn();
  showToast('Configuracion guardada ✓');
  showScreen('chat');
}

function updateStatusBadges() {
  const groqOk = !!S.groqKey;
  const el = (id) => document.getElementById(id);

  el('groq-ok-badge') && (el('groq-ok-badge').style.display = groqOk ? '' : 'none');
  el('groq-warn-badge') && (el('groq-warn-badge').style.display = groqOk ? 'none' : '');
  el('groq-settings-sub') && (el('groq-settings-sub').textContent = groqOk ? `Modelo: ${S.model.replace('-versatile','').replace('-distill-llama-70b',' R1')}` : 'Configura tu API key (gratis)');

  const ghOk = !!S.repoData;
  el('gh-settings-badge') && (el('gh-settings-badge').style.display = ghOk ? 'none' : '');
  el('gh-settings-badge-ok') && (el('gh-settings-badge-ok').style.display = ghOk ? '' : 'none');
  el('gh-settings-sub') && (el('gh-settings-sub').textContent = ghOk ? S.repoData.full_name : 'Conecta un repositorio');
  el('gh-dot') && (el('gh-dot').style.display = ghOk ? '' : 'none');
}

function updateModelBtn() {
  const el = document.getElementById('model-ibtn-txt');
  if (el) {
    const short = (S.model || '').split('-').slice(0,2).join('-').replace('llama','llama');
    el.textContent = S.model.includes('deepseek') ? 'deepseek-r1' : S.model.replace('-versatile','').replace('llama-3.3','llama-3.3').replace('llama3-','llama3-').replace('-8192','').replace('-32768','');
  }
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
    c.innerHTML = `
      <div class="fg" style="margin-bottom:16px">
        <label class="fl">URL del repositorio</label>
        <input class="fi" type="url" id="repo-url" placeholder="https://github.com/usuario/repo" value="${S.repoData ? 'https://github.com/'+S.repoData.full_name : ''}">
        <div class="fh">Publicos funcionan sin token. Para privados, agrega tu token en Config.</div>
      </div>
      <div class="fg">
        <label class="fl">Rama</label>
        <input class="fi" type="text" id="repo-branch" placeholder="main" value="${S.branch}">
      </div>`;
    setTimeout(() => document.getElementById('repo-url')?.focus(), 150);
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
        <div style="width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 8px 24px rgba(91,115,255,.3)">
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
  const url = document.getElementById('repo-url')?.value || (S.repoData ? 'https://github.com/'+S.repoData.full_name : '');
  const info = document.getElementById('modal-info');
  if (!url || !info) return;
  try {
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!match) throw new Error('URL invalida');
    const repo = match[1].replace(/\.git$/, '');
    const headers = S.ghToken ? { 'Authorization': `token ${S.ghToken}` } : {};
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!r.ok) throw new Error(`Error ${r.status}`);
    const data = await r.json();
    info.innerHTML = `<div style="font-weight:700;color:var(--text);margin-bottom:6px;font-size:14px">${data.full_name}</div>
      <div style="color:var(--text2);margin-bottom:10px">${data.description || 'Sin descripcion'}</div>
      <div style="display:flex;gap:16px;font-size:11.5px;flex-wrap:wrap">
        <span style="color:var(--text3)">Lang: <strong style="color:var(--text2)">${data.language || 'varios'}</strong></span>
        <span style="color:var(--text3)">⭐ <strong style="color:var(--text2)">${data.stargazers_count}</strong></span>
        <span style="color:var(--text3)">${data.private ? '🔒 Privado' : '🌐 Publico'}</span>
      </div>`;
  } catch(e) {
    info.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  }
}

async function modalNext() {
  if (modalStep === 1) {
    const url = document.getElementById('repo-url').value.trim();
    const branch = document.getElementById('repo-branch').value.trim() || 'main';
    if (!url) { showToast('Ingresa la URL del repositorio'); return; }
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!match) { showToast('URL invalida'); return; }
    S.branch = branch;
    S._pendingRepo = match[1].replace(/\.git$/, '');
    modalStep = 2;
    renderStep();
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
// GITHUB API
// ═══════════════════════════════════════════
function ghHeaders() {
  const h = { 'Accept': 'application/vnd.github+json' };
  if (S.ghToken) h['Authorization'] = `token ${S.ghToken}`;
  return h;
}

async function connectRepo(repo) {
  const headers = ghHeaders();
  const [rData, treeData] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}`, { headers }).then(r => { if(!r.ok) throw new Error(`Repo no encontrado (${r.status})`); return r.json(); }),
    fetch(`https://api.github.com/repos/${repo}/git/trees/${S.branch}?recursive=1`, { headers }).then(r => { if(!r.ok) throw new Error(`No se pudo leer arbol (${r.status})`); return r.json(); })
  ]);

  S.repoData = rData;
  const skipExts = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|gz|lock|bin|exe|dll|DS_Store)$/i;
  const skipDirs = /^(node_modules|\.git|dist|build|\.next|coverage|vendor|\.cache|\.parcel-cache|__pycache__)\//i;
  S.files = (treeData.tree || [])
    .filter(f => f.type === 'blob' && !skipExts.test(f.path) && !skipDirs.test(f.path))
    .map(f => ({ path: f.path, sha: f.sha }));

  S.ok = true;
  S.branch = rData.default_branch || S.branch;

  // Update UI
  const dot = document.getElementById('conn-dot');
  if (dot) { dot.classList.add('ok'); }
  const tbSub = document.getElementById('tb-sub');
  if (tbSub) tbSub.textContent = rData.name + ' · ' + S.files.length + ' archivos';

  const ghIbtnTxt = document.getElementById('gh-ibtn-txt');
  if (ghIbtnTxt) ghIbtnTxt.textContent = rData.name;
  const ghIbtn = document.getElementById('gh-ibtn');
  if (ghIbtn) ghIbtn.classList.add('gok');

  updateStatusBadges();
  renderFileList();
}

async function fetchFile(path) {
  if (!S.repoData) return null;
  try {
    const headers = ghHeaders();
    const r = await fetch(`https://api.github.com/repos/${S.repoData.full_name}/contents/${path}?ref=${S.branch}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    return atob(data.content.replace(/\n/g, ''));
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
  if (title) title.textContent = S.repoData.name + ' — ' + S.files.length + ' archivos';

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
  if (!S.ghToken || !S.repoData) return;
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
    list.innerHTML = `<div style="font-size:13px;color:var(--text3);padding:8px 0;line-height:1.6">No hay cambios automaticos detectados. El agente genera diffs — aplicalos o usa el token con permisos <code style="background:var(--bg3);padding:1px 5px;border-radius:3px">repo</code>.</div>`;
  }
  document.getElementById('push-modal').classList.add('open');
}
function closePushModal() { document.getElementById('push-modal').classList.remove('open'); }

async function confirmPush() {
  if (!S.ghToken) { showToast('Configura tu GitHub Token'); return; }
  if (!S.repoData) { showToast('No hay repo conectado'); return; }
  if (!S.pendingEdits.length) { showToast('No hay cambios para subir'); return; }

  const msg = document.getElementById('push-commit-msg').value.trim() || 'update via DevAgent';
  const branch = document.getElementById('push-branch').value.trim() || S.branch;
  const btn = document.getElementById('push-confirm-btn');
  const result = document.getElementById('push-result');

  btn.disabled = true;
  btn.textContent = 'Subiendo...';

  const headers = { ...ghHeaders(), 'Content-Type': 'application/json' };
  let pushed = 0;
  const errors = [];

  for (const edit of S.pendingEdits) {
    try {
      const r = await fetch(`https://api.github.com/repos/${S.repoData.full_name}/contents/${edit.path}?ref=${branch}`, { headers });
      let sha = null;
      if (r.ok) { const d = await r.json(); sha = d.sha; }
      const body = { message: msg, content: btoa(unescape(encodeURIComponent(edit.newContent))), branch };
      if (sha) body.sha = sha;
      const pr = await fetch(`https://api.github.com/repos/${S.repoData.full_name}/contents/${edit.path}`, { method:'PUT', headers, body:JSON.stringify(body) });
      if (!pr.ok) { const e = await pr.json(); throw new Error(e.message || pr.status); }
      pushed++;
    } catch(e) { errors.push(`${edit.path}: ${e.message}`); }
  }

  result.style.display = '';
  if (!errors.length) {
    result.innerHTML = `<div style="background:var(--gb);border:1px solid var(--gd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--green);font-weight:600">✓ ${pushed} archivo(s) subido(s)</div>`;
    S.pendingEdits = [];
    btn.textContent = 'Hecho';
    setTimeout(() => closePushModal(), 1800);
  } else {
    result.innerHTML = `<div style="background:var(--rb);border:1px solid var(--rd);border-radius:var(--r);padding:12px;font-size:13px;color:var(--red)">${errors.join('\n')}</div>`;
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
    document.getElementById('stopbtn').style.display = '';
  } else {
    dot?.classList.remove('busy');
    if (S.ok) dot?.classList.add('ok');
    document.getElementById('sndbtn').style.display = '';
    document.getElementById('stopbtn').style.display = 'none';
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

// ═══════════════════════════════════════════
// MARKDOWN + DIFF RENDERER
// ═══════════════════════════════════════════
function md(text) {
  let s = esc(text);

  // Code blocks
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb' + Math.random().toString(36).slice(2,7);
    const isDiff = lang === 'diff' || (!lang && code.match(/^[+-]/m));
    let rendered = code;
    if (isDiff) {
      rendered = code.split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${line}</span>`;
        if (line.startsWith('@@')) return `<span class="diff-hunk">${line}</span>`;
        return `<span class="diff-ctx">${line}</span>`;
      }).join('\n');
    }
    const applyBtn = isDiff ? `<button class="cblock-btn apply" onclick="applyDiff('${id}',this)">${checkSvg()} Aplicar</button><button class="cblock-btn reject" onclick="rejectDiff(this)">${xSvg()} Descartar</button>` : '';
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
  s = s.replace(/^(?!<[hulo]|<li|<hr|<div|<pre|<ul|<block)(.+)$/gm, '<p>$1</p>');
  s = s.replace(/<p><\/p>/g, '');
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
function applyDiff(id, btn) {
  btn.innerHTML = checkSvg() + ' Aplicado';
  btn.classList.add('done');
  btn.disabled = true;
  showToast('Diff marcado como aplicado');
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
// AI — GROQ API
// ═══════════════════════════════════════════
function buildSystemPrompt() {
  let sys = `Eres DevAgent, un agente autonomo de desarrollo de software de nivel experto. Combinas las capacidades de Claude Code, GitHub Copilot y Codex.

CAPACIDADES:
- Analisis profundo de codebases completas
- Deteccion y correccion quirurgica de bugs con diffs exactos
- Auditorias de seguridad OWASP Top 10
- Optimizacion de rendimiento (lazy loading, N+1 queries, caching)
- Refactorizacion con SOLID, DRY, Clean Code
- Generacion de tests unitarios y de integracion
- Documentacion tecnica completa
- Migracion de frameworks y actualizacion de dependencias

REGLAS CRITICAS DE EDICION:
1. NUNCA reescribas archivos completos — solo ediciones quirurgicas
2. Usa SIEMPRE formato diff exacto para cambios de codigo:
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
3. Incluye siempre 2-3 lineas de contexto alrededor de cada cambio
4. Explica brevemente cada cambio antes del diff

FORMATO DE RESPUESTA:
- Markdown rico: headers, listas, bold, blockquotes
- Para bugs: archivo → linea → descripcion → diff
- Para analisis: resumen ejecutivo → problemas criticos (numerados) → recomendaciones
- Sé preciso y conciso. Cada palabra debe aportar valor.`;

  if (S.repoData) {
    sys += `\n\nREPOSITORIO ACTIVO:
- Nombre: ${S.repoData.full_name}
- Lenguaje: ${S.repoData.language || 'varios'}
- Rama: ${S.branch}
- Archivos indexados: ${S.files.length}`;
  }

  if (S.instructions) sys += `\n\nINSTRUCCIONES DEL PROYECTO (maxima prioridad):\n${S.instructions}`;
  if (S.planModeEnabled) sys += `\n\nMODO PLAN: Antes de cualquier implementacion, presenta un plan numerado y espera confirmacion.`;

  return sys;
}

async function callAI(msg, onStream) {
  if (!S.groqKey) throw new Error('No hay API key de Groq. Ve a Configuracion.');

  const messages = [
    { role:'system', content:buildSystemPrompt() },
    ...S.history.slice(-14),
    { role:'user', content:msg }
  ];

  S.abortController = new AbortController();

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${S.groqKey}`, 'Content-Type':'application/json' },
    signal:S.abortController.signal,
    body:JSON.stringify({ model:S.model, messages, max_tokens:8192, temperature:0.15, stream:true })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Error ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let totalIn = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const p = JSON.parse(data);
        result += p.choices?.[0]?.delta?.content || '';
        totalIn = (p.usage?.total_tokens || 0) || totalIn;
        if (onStream) onStream(result);
      } catch {}
    }
  }

  S.history.push({ role:'user', content:msg });
  S.history.push({ role:'assistant', content:result });

  const estTokens = Math.round((buildSystemPrompt().length + msg.length + result.length) / 4);
  updateContextBar(estTokens);

  return result;
}

// ═══════════════════════════════════════════
// FILE RELEVANCE
// ═══════════════════════════════════════════
function findRelevantFiles(msg) {
  if (!S.files.length) return [];
  const lower = msg.toLowerCase();
  return S.files.map(f => {
    let score = 0;
    const p = f.path.toLowerCase();
    const name = p.split('/').pop().replace(/\.\w+$/, '');

    if (lower.includes(f.path.toLowerCase())) score += 100;
    if (lower.includes(name)) score += 35;

    const kw = {
      auth:['auth','login','session','token','jwt','password'],
      db:['database','db','model','schema','migration','query','sql','orm'],
      api:['api','route','endpoint','controller','handler','rest','graphql'],
      ui:['component','view','page','template','style','css','ui','layout'],
      test:['test','spec','jest','mocha','cypress','vitest'],
      config:['config','env','settings','webpack','vite','babel','tsconfig'],
      main:['main','index','app','server','entry','start'],
    };
    for (const [, words] of Object.entries(kw)) {
      if (words.some(w => lower.includes(w)) && words.some(w => p.includes(w))) score += 22;
    }

    const codeExts = ['.js','.ts','.jsx','.tsx','.py','.go','.rs','.java','.php','.rb','.cs'];
    if (codeExts.some(e => p.endsWith(e))) score += 4;

    const important = ['package.json','requirements.txt','go.mod','index.js','app.js','main.py','server.js','main.ts','app.ts','readme.md'];
    if (important.includes(p.split('/').pop())) score += 12;

    return { ...f, score };
  })
  .filter(f => f.score > 0)
  .sort((a,b) => b.score - a.score)
  .slice(0, S.fileLimit);
}

function detectEditsAndShowPushBanner(text) {
  if (!S.repoData || !S.ghToken) return;
  const files = [];
  const matches = text.match(/--- a\/(.+)/g) || [];
  matches.forEach(m => {
    const path = m.replace('--- a/', '').trim();
    if (!files.includes(path)) files.push(path);
    if (!S.pendingEdits.find(e => e.path === path)) {
      S.pendingEdits.push({ path, newContent:'', originalContent:'' });
    }
  });
  if (files.length) showPushBanner(files);
}

// ═══════════════════════════════════════════
// AUTO ANALYZE
// ═══════════════════════════════════════════
function autoAnalyze() {
  if (!S.repoData) return;
  const msg = `✓ **${S.repoData.full_name}** conectado — **${S.files.length} archivos** en la rama **${S.branch}**\n\nPuedo analizar el repositorio, detectar bugs, hacer auditorias de seguridad, optimizar rendimiento o generar tests. ¿Por donde empezamos?`;
  addMsg('ai', msg);
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

  if (!S.groqKey) {
    showToast('Configura tu API key primero');
    showScreen('settings');
    return;
  }

  S.busy = true;
  inp.value = '';
  inp.style.height = 'auto';
  document.getElementById('sndbtn').disabled = true;

  addMsg('me', msg);
  clearActivityLog();
  showActivity(true, 'Analizando tarea...');

  let enriched = msg;

  if (S.repoData && S.files.length) {
    const relevant = findRelevantFiles(msg);

    if (relevant.length) {
      log('info', `${relevant.length} archivos relevantes encontrados`, relevant.slice(0,3).map(f=>f.path).join(', '));

      let ctx = '';
      for (const r of relevant) {
        log('run', `Leyendo ${r.path}`);
        const content = await fetchFile(r.path);
        if (content) {
          const lines = content.split('\n');
          const snippet = lines.length > 180 ? lines.slice(0,180).join('\n') + `\n... [${lines.length-180} lineas mas]` : content;
          ctx += `\n\n---\n### ${r.path}\n\`\`\`\n${snippet}\n\`\`\``;
          updateLastLog('ok', `Leido: ${r.path}`, `${lines.length} lineas`);
        }
      }

      if (ctx) enriched = `${msg}\n\n## Contenido de archivos relevantes\n${ctx}\n\n## Instruccion\nUsa el codigo de arriba para resolver la tarea con diffs quirurgicos exactos.`;
    } else {
      log('info', 'Contexto general del repo', `${S.files.length} archivos disponibles`);
      enriched = `${msg}\n\n## Estructura del repo\n\`\`\`\n${S.files.slice(0,60).map(f=>f.path).join('\n')}\n\`\`\``;
    }
  }

  log('run', 'Generando respuesta...', S.model);
  const streamEl = mkStream();
  let result = '';

  try {
    result = await callAI(enriched, (text) => { patchStream(streamEl, text); });
    finalStream(streamEl, result);
    updateLastLog('ok', 'Completado');
    showActivity(false);
    detectEditsAndShowPushBanner(result);
  } catch(e) {
    if (e.name === 'AbortError') {
      finalStream(streamEl, result || '_Generacion detenida._');
    } else {
      finalStream(streamEl, `**Error:** ${e.message}\n\n${!S.groqKey ? 'Ve a **Configuracion** para agregar tu API key de Groq.' : ''}`);
      updateLastLog('err', 'Error', e.message);
    }
    showActivity(false);
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

function clearChat() {
  if (S.busy) { showToast('El agente esta trabajando'); return; }
  document.getElementById('msgs').innerHTML = '';
  document.getElementById('empty').classList.remove('gone');
  showActivity(false);
  hidePushBanner();
  S.history = [];
  S.pendingEdits = [];
  clearActivityLog();
  document.getElementById('context-bar')?.classList.remove('show');
  showToast('Conversacion nueva');
}

// ═══════════════════════════════════════════
// INPUT TEMPLATES
// ═══════════════════════════════════════════
const TEMPLATES = {
  plan: 'Crea un plan de implementacion detallado para: ',
  fix: 'Encuentra y corrige el bug en `ARCHIVO` donde ',
  explain: 'Explica como funciona el archivo `ARCHIVO` y que hace cada funcion principal',
  add: 'Agrega la siguiente funcionalidad al proyecto: ',
  review: 'Haz un code review completo de `ARCHIVO` y sugiere mejoras con diffs',
  test: 'Genera tests unitarios completos para `ARCHIVO` con casos edge y mocks',
};

function insertTemplate(name) {
  const inp = document.getElementById('inp');
  inp.value = TEMPLATES[name] || '';
  inp.focus();
  inp.style.height = 'auto';
  inp.style.height = Math.min(inp.scrollHeight, 140) + 'px';
  document.getElementById('sndbtn').disabled = !inp.value.trim();
}

// ═══════════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closePushModal(); closeFileViewer(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); clearChat(); }
});

document.getElementById('modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});
document.getElementById('push-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('push-modal')) closePushModal();
});

document.getElementById('inp').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  document.getElementById('sndbtn').disabled = !this.value.trim() || S.busy;
});

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
loadSettings();

if (!S.groqKey) {
  setTimeout(() => {
    showToast('Configura tu API key de Groq para comenzar');
    setTimeout(() => showScreen('settings'), 600);
  }, 1000);
}

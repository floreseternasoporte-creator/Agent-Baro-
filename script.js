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
  pendingEdits: [], // { path, newContent, originalContent }
  multiAgentEnabled: true,
};

// ═══════════════════════════════════════════
// SETTINGS (localStorage)
// ═══════════════════════════════════════════
function loadSettings() {
  S.groqKey = localStorage.getItem('da_groq_key') || '';
  S.ghToken = localStorage.getItem('da_gh_token') || '';
  S.model = localStorage.getItem('da_model') || 'llama-3.3-70b-versatile';
  S.multiAgentEnabled = localStorage.getItem('da_multi_agent') !== 'false';
  updateSettingsBadges();
}

function saveSettings() {
  const key = document.getElementById('set-groq').value.trim();
  const tok = document.getElementById('set-ghtoken').value.trim();
  const mdl = document.getElementById('set-model').value;

  if (!key) { showToast('La API key de Groq es requerida'); return; }

  localStorage.setItem('da_groq_key', key);
  localStorage.setItem('da_gh_token', tok);
  localStorage.setItem('da_model', mdl);
  localStorage.setItem('da_multi_agent', S.multiAgentEnabled ? 'true' : 'false');

  S.groqKey = key;
  S.ghToken = tok;
  S.model = mdl;

  updateSettingsBadges();
  closeSettings();
  showToast('Configuracion guardada');
}

function updateSettingsBadges() {
  const groqOk = !!S.groqKey;
  document.getElementById('groq-badge').style.display = groqOk ? '' : 'none';
  document.getElementById('groq-warn').style.display = groqOk ? 'none' : '';
  document.getElementById('groq-sub').textContent = groqOk
    ? `Modelo: ${S.model}`
    : 'Haz clic para configurar tu API key';
}

function openSettings() {
  document.getElementById('set-groq').value = S.groqKey || '';
  document.getElementById('set-ghtoken').value = S.ghToken || '';
  document.getElementById('set-model').value = S.model || 'llama-3.3-70b-versatile';
  const tog = document.getElementById('multiagent-toggle');
  if (S.multiAgentEnabled) tog.classList.add('on'); else tog.classList.remove('on');
  document.getElementById('settings-modal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}

function toggleMultiAgent() {
  S.multiAgentEnabled = !S.multiAgentEnabled;
  const tog = document.getElementById('multiagent-toggle');
  if (S.multiAgentEnabled) tog.classList.add('on'); else tog.classList.remove('on');
}

// ═══════════════════════════════════════════
// GITHUB MODAL — multi-step
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
  document.getElementById('modal-next').textContent = modalStep === 3 ? 'Listo' : 'Continuar';
  document.getElementById('modal-title').textContent = ['Conectar repositorio','Opciones','Confirmacion'][modalStep-1];

  ['stp1','stp2','stp3'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = 'stp';
    if (i+1 < modalStep) el.classList.add('done');
    else if (i+1 === modalStep) el.classList.add('active');
  });

  if (modalStep === 1) {
    c.innerHTML = `
      <div class="fg">
        <label class="fl">URL del repositorio</label>
        <input class="fi" type="url" id="repo-url" placeholder="https://github.com/usuario/repo" value="${S.repoData ? 'https://github.com/'+S.repoData.full_name : ''}">
        <div class="fh">Repositorios publicos funcionan sin token. Para privados configura el token en Ajustes.</div>
      </div>
      <div class="fg">
        <label class="fl">Rama</label>
        <input class="fi" type="text" id="repo-branch" placeholder="main" value="${S.branch}">
      </div>`;
  } else if (modalStep === 2) {
    c.innerHTML = `
      <div class="fg">
        <label class="fl">Instrucciones personalizadas <span style="color:var(--text3);font-size:10px">opcional</span></label>
        <textarea class="fi" id="repo-inst" rows="3" placeholder="Ej: El proyecto usa TypeScript estricto. Los componentes van en src/components/">${S.instructions}</textarea>
        <div class="fh">El agente tendra estas instrucciones en contexto en toda la sesion.</div>
      </div>
      <div id="modal-info" style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:12px;font-size:12px;color:var(--text2)">
        Cargando info del repositorio...
      </div>`;
    loadRepoInfo();
  } else {
    const r = S.repoData;
    c.innerHTML = `
      <div style="text-align:center;padding:12px 0">
        <div style="width:44px;height:44px;border-radius:10px;background:var(--gb);border:1px solid var(--gd);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">
          <svg width="22" height="22" viewBox="0 0 16 16" fill="var(--green)"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
        </div>
        <div style="font-size:14px;font-weight:600;margin-bottom:4px">${r ? r.full_name : 'Repositorio'}</div>
        <div style="font-size:11.5px;color:var(--text2)">${r ? (r.description || 'Sin descripcion') : ''}</div>
        <div style="display:flex;justify-content:center;gap:16px;margin-top:12px;font-size:11px;color:var(--text3)">
          <span>${S.files.length} archivos indexados</span>
          <span>${r ? (r.language || 'multi-lenguaje') : ''}</span>
          <span>Rama: ${S.branch}</span>
        </div>
      </div>`;
  }
}

async function loadRepoInfo() {
  const url = document.getElementById('repo-url')?.value || (S.repoData ? 'https://github.com/'+S.repoData.full_name : '');
  const info = document.getElementById('modal-info');
  if (!url) { if(info) info.textContent = 'No hay URL de repositorio.'; return; }
  try {
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!match) throw new Error('URL invalida');
    const repo = match[1].replace(/\.git$/, '');
    const headers = S.ghToken ? { 'Authorization': `token ${S.ghToken}` } : {};
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers });
    if (!r.ok) throw new Error(`Error ${r.status}`);
    const data = await r.json();
    if (info) info.innerHTML = `
      <div style="font-weight:500;color:var(--text);margin-bottom:4px">${data.full_name}</div>
      <div style="margin-bottom:2px">${data.description || 'Sin descripcion'}</div>
      <div style="margin-top:6px;display:flex;gap:12px;font-size:10.5px">
        <span>Lenguaje: ${data.language || 'varios'}</span>
        <span>Stars: ${data.stargazers_count}</span>
        <span>${data.private ? 'Privado' : 'Publico'}</span>
      </div>`;
  } catch(e) {
    if (info) info.textContent = 'No se pudo cargar la info: ' + e.message;
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
    document.getElementById('modal-next').textContent = 'Conectando...';
    document.getElementById('modal-next').disabled = true;
    try {
      await connectRepo(S._pendingRepo);
      modalStep = 3;
      renderStep();
    } catch(e) {
      showToast('Error: ' + e.message);
    }
    document.getElementById('modal-next').disabled = false;
    document.getElementById('modal-next').textContent = 'Listo';
  } else {
    closeModal();
    if (S.ok && S.files.length) autoAnalyze();
  }
}
function modalBack() {
  if (modalStep > 1) { modalStep--; renderStep(); }
}

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
    fetch(`https://api.github.com/repos/${repo}`, { headers }).then(r => { if(!r.ok) throw new Error(`Repo: ${r.status}`); return r.json(); }),
    fetch(`https://api.github.com/repos/${repo}/git/trees/${S.branch}?recursive=1`, { headers }).then(r => { if(!r.ok) throw new Error(`Tree: ${r.status}`); return r.json(); })
  ]);

  S.repoData = rData;
  const skipExts = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|gz|lock)$/i;
  const skipDirs = /^(node_modules|\.git|dist|build|\.next|coverage|vendor)\//i;
  S.files = (treeData.tree || [])
    .filter(f => f.type === 'blob' && !skipExts.test(f.path) && !skipDirs.test(f.path))
    .map(f => ({ path: f.path, sha: f.sha }));

  S.ok = true;
  S.branch = rData.default_branch || S.branch;

  setChip(true, `${rData.full_name} (${S.files.length} archivos)`);
  document.getElementById('files-tbtn').style.display = '';
  document.getElementById('gh-ibtn').classList.add('gok');
  document.getElementById('gh-badge').style.display = '';
  document.getElementById('gh-sub').textContent = rData.full_name;
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
// GITHUB PUSH
// ═══════════════════════════════════════════
function hidePushBanner() {
  document.getElementById('push-banner').classList.remove('show');
}

function showPushBanner(editedFiles) {
  if (!S.ghToken || !S.repoData) return;
  const detail = editedFiles.length === 1
    ? `1 archivo listo para commit: ${editedFiles[0]}`
    : `${editedFiles.length} archivos listos para commit`;
  document.getElementById('push-banner-detail').textContent = detail;
  document.getElementById('push-banner').classList.add('show');
}

function doPush() {
  hidePushBanner();
  openPushModal();
}

function openPushModal() {
  const now = new Date();
  const defaultMsg = `chore: update via DevAgent ${now.toISOString().slice(0,10)}`;
  document.getElementById('push-commit-msg').value = defaultMsg;
  document.getElementById('push-branch').value = S.branch;
  document.getElementById('push-result').style.display = 'none';
  document.getElementById('push-confirm-btn').disabled = false;
  document.getElementById('push-confirm-btn').textContent = 'Confirmar push';

  // List pending edits
  const list = document.getElementById('push-files-list');
  if (S.pendingEdits.length) {
    list.innerHTML = `<div class="sh-label" style="padding:0 0 6px">Archivos a subir</div>` +
      S.pendingEdits.map(e => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:11.5px">
        <span style="color:var(--green)">M</span>
        <span style="font-family:var(--mono);color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.path)}</span>
      </div>`).join('');
  } else {
    list.innerHTML = `<div style="font-size:12px;color:var(--text3);padding:8px 0">No hay cambios pendientes detectados automaticamente. El agente genera ediciones en formato diff — aplicalas manualmente al repositorio o usa el token con permisos <code>repo</code> para push automatico.</div>`;
  }
  document.getElementById('push-modal').classList.add('open');
}
function closePushModal() { document.getElementById('push-modal').classList.remove('open'); }

async function confirmPush() {
  if (!S.ghToken) { showToast('Configura un GitHub token primero'); return; }
  if (!S.repoData) { showToast('No hay repositorio conectado'); return; }
  if (!S.pendingEdits.length) { showToast('No hay cambios para subir'); return; }

  const msg = document.getElementById('push-commit-msg').value.trim() || 'update via DevAgent';
  const branch = document.getElementById('push-branch').value.trim() || S.branch;
  const btn = document.getElementById('push-confirm-btn');
  const result = document.getElementById('push-result');

  btn.disabled = true;
  btn.textContent = 'Subiendo...';
  result.style.display = 'none';

  const headers = { ...ghHeaders(), 'Content-Type': 'application/json' };
  const errors = [];
  let pushed = 0;

  for (const edit of S.pendingEdits) {
    try {
      // Get current file SHA
      const r = await fetch(`https://api.github.com/repos/${S.repoData.full_name}/contents/${edit.path}?ref=${branch}`, { headers });
      let sha = null;
      if (r.ok) { const d = await r.json(); sha = d.sha; }

      const body = { message: msg, content: btoa(unescape(encodeURIComponent(edit.newContent))), branch };
      if (sha) body.sha = sha;

      const pr = await fetch(`https://api.github.com/repos/${S.repoData.full_name}/contents/${edit.path}`, {
        method: 'PUT', headers, body: JSON.stringify(body)
      });
      if (!pr.ok) { const e = await pr.json(); throw new Error(e.message || pr.status); }
      pushed++;
    } catch(e) {
      errors.push(`${edit.path}: ${e.message}`);
    }
  }

  result.style.display = '';
  if (errors.length === 0) {
    result.innerHTML = `<div style="background:var(--gb);border:1px solid var(--gd);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--green)">${pushed} archivo(s) subido(s) correctamente a ${S.repoData.full_name}/${branch}</div>`;
    S.pendingEdits = [];
    btn.textContent = 'Hecho';
    setTimeout(() => closePushModal(), 2000);
  } else {
    result.innerHTML = `<div style="background:var(--rb);border:1px solid rgba(248,113,113,.2);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--red)">${pushed} subidos, ${errors.length} errores:<br>${errors.join('<br>')}</div>`;
    btn.disabled = false;
    btn.textContent = 'Reintentar';
  }
}

// ═══════════════════════════════════════════
// SHEET
// ═══════════════════════════════════════════
function toggleSheet() {
  const s = document.getElementById('so');
  s.classList.toggle('open');
}
function closeSheet() { document.getElementById('so').classList.remove('open'); }

// ═══════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════
function setChip(ok, text) {
  const chip = document.getElementById('schip');
  const dot = document.getElementById('sdot');
  const txt = document.getElementById('schip-txt');
  chip.className = 'status-chip' + (ok ? ' ok' : '');
  dot.className = 'sdot' + (ok ? ' ok' : '');
  txt.textContent = text;
}

function setBusy(b, text='Trabajando...') {
  const dot = document.getElementById('sdot');
  dot.className = 'sdot' + (b ? ' busy' : (S.ok ? ' ok' : ''));
  if (b) document.getElementById('act-head-txt').textContent = text;
}

function showActivity(show, text='') {
  const el = document.getElementById('activity');
  if (show) {
    el.classList.add('show');
    if (text) document.getElementById('act-head-txt').textContent = text;
    setBusy(true, text);
  } else {
    el.classList.remove('show');
    setBusy(false);
  }
}

let _logEntries = [];
function log(type, title, detail='') {
  const el = document.getElementById('act-log');
  const icons = {
    run: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>`,
    ok: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`,
    err: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.47.22A.75.75 0 015 0h6a.75.75 0 01.53.22l4.25 4.25c.141.14.22.331.22.53v6a.75.75 0 01-.22.53l-4.25 4.25A.75.75 0 0111 16H5a.75.75 0 01-.53-.22L.22 11.53A.75.75 0 010 11V5a.75.75 0 01.22-.53L4.47.22zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5H5.31zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    info: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6.5 7.75A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    agent: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM3.75 2a1.25 1.25 0 100 2.5A1.25 1.25 0 003.75 2zm6.5 1.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zm2.25-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5zM0 12C0 9.51 2.01 8 4 8s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 010 12.75V12zm4-2.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5zm8-2.5c2 0 4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 018 12.75V12c0-2.49 2.01-4 4-4zm0 1.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5z"/></svg>`,
  };
  const row = document.createElement('div');
  row.className = 'act-row';
  row.innerHTML = `<div class="act-ic ${type}">${icons[type]||icons.info}</div><div class="act-txt"><div class="act-title">${esc(title)}</div>${detail?`<div class="act-detail">${esc(detail)}</div>`:''}</div>`;
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  _logEntries.push(row);
  return row;
}

function updateLastLog(type, title, detail='') {
  const icons = {
    run: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>`,
    ok: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`,
    err: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.47.22A.75.75 0 015 0h6a.75.75 0 01.53.22l4.25 4.25c.141.14.22.331.22.53v6a.75.75 0 01-.22.53l-4.25 4.25A.75.75 0 0111 16H5a.75.75 0 01-.53-.22L.22 11.53A.75.75 0 010 11V5a.75.75 0 01.22-.53L4.47.22zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5H5.31zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    info: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6.5 7.75A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    agent: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM3.75 2a1.25 1.25 0 100 2.5A1.25 1.25 0 003.75 2zm6.5 1.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zm2.25-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5zM0 12C0 9.51 2.01 8 4 8s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 010 12.75V12zm4-2.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5zm8-2.5c2 0 4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 018 12.75V12c0-2.49 2.01-4 4-4zm0 1.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5z"/></svg>`,
  };
  if (_logEntries.length) {
    const row = _logEntries[_logEntries.length - 1];
    row.className = `act-row`;
    row.innerHTML = `<div class="act-ic ${type}">${icons[type]||icons.info}</div><div class="act-txt"><div class="act-title">${esc(title)}</div>${detail?`<div class="act-detail">${esc(detail)}</div>`:''}</div>`;
  }
}

function clearActivityLog() {
  document.getElementById('act-log').innerHTML = '';
  _logEntries = [];
}

let _toastT;
function showToast(t) {
  const el = document.getElementById('toast');
  el.textContent = t;
  el.classList.add('on');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('on'), 2800);
}

function now() {
  return new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════
// MARKDOWN + DIFF RENDERER
// ═══════════════════════════════════════════
function md(text) {
  let s = esc(text);

  // Code blocks with diff rendering
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb' + Math.random().toString(36).slice(2,7);
    let rendered = code;
    if (lang === 'diff' || code.match(/^[+-]/m)) {
      rendered = code.split('\n').map(line => {
        if (line.startsWith('+')) return `<span class="diff-add">${line}</span>`;
        if (line.startsWith('-')) return `<span class="diff-del">${line}</span>`;
        return `<span class="diff-ctx">${line}</span>`;
      }).join('\n');
    }
    return `<div class="cblock"><div class="cblock-head"><span class="clang">${lang||'code'}</span><button class="ccopy" onclick="cpBlock('${id}',this)">${copyIcon()} Copiar</button></div><pre id="${id}">${rendered}</pre></div>`;
  });

  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/^- (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  s = s.replace(/^---$/gm, '<hr>');
  s = s.replace(/^(?!<[hulo]|<li|<hr|<div|<pre)(.+)$/gm, '<p>$1</p>');
  s = s.replace(/<p><\/p>/g, '');

  return s;
}

function copyIcon() {
  return `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>`;
}

function cpBlock(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText).then(() => {
    btn.classList.add('done');
    btn.innerHTML = `${copyIcon()} Copiado`;
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = `${copyIcon()} Copiar`; }, 2000);
  });
}

// ═══════════════════════════════════════════
// CHAT HELPERS
// ═══════════════════════════════════════════
function hideEmpty() { document.getElementById('empty').classList.add('gone'); }
function scrollChat() {
  const c = document.getElementById('chat');
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

function addMsg(role, text) {
  hideEmpty();
  const msgsEl = document.getElementById('msgs');
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `
    <div class="msg-head">
      <div class="av ${role}">${role==='ai'?'AI':'TU'}</div>
      <span class="mname">${role==='ai'?'DevAgent':'Tu'}</span>
      <span class="mtime">${now()}</span>
    </div>
    <div class="mbody">${role==='ai' ? md(text) : esc(text)}</div>`;
  msgsEl.appendChild(el);
  scrollChat();
  return el;
}

function mkStream() {
  hideEmpty();
  const msgsEl = document.getElementById('msgs');
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.innerHTML = `
    <div class="msg-head">
      <div class="av ai">AI</div>
      <span class="mname">DevAgent</span>
      <span class="mtime">${now()}</span>
    </div>
    <div class="mbody" id="stream-body"><span class="scursor"></span></div>`;
  msgsEl.appendChild(el);
  scrollChat();
  return el;
}

function patchStream(el, text) {
  const b = el.querySelector('#stream-body');
  if (b) { b.innerHTML = md(text) + '<span class="scursor"></span>'; scrollChat(); }
}

function finalStream(el, text, chips=[]) {
  const b = el.querySelector('#stream-body') || el.querySelector('.mbody');
  if (b) { b.id = ''; b.innerHTML = md(text); }
  if (chips.length) {
    const d = document.createElement('div'); d.className = 'chips';
    d.innerHTML = chips.map(c => `<button class="chip" onclick="doQuick(${JSON.stringify(c.action)})">${esc(c.label)}</button>`).join('');
    el.appendChild(d);
  }
  S.history.push({ role: 'assistant', content: text });
  if (S.history.length > 20) S.history = S.history.slice(-20);
  scrollChat();
}

// ═══════════════════════════════════════════
// GROQ AI CORE
// ═══════════════════════════════════════════
function buildSysPrompt() {
  const repo = S.repoData ? `## Repositorio activo
- Nombre: ${S.repoData.full_name}
- Lenguaje: ${S.repoData.language || 'varios'}
- Rama: ${S.branch}
- Total de archivos: ${S.files.length}
- Lista de archivos indexados:
\`\`\`
${S.files.map(f=>f.path).join('\n')}
\`\`\`
` : '';
  const instr = S.instructions ? `## Instrucciones del proyecto\n${S.instructions}\n` : '';

  return `Eres DevAgent, un agente autonomo de edicion de codigo de precision maxima, similar a Codex o Claude Code.

${repo}${instr}

## REGLA ABSOLUTA — EDICION QUIRURGICA
NUNCA reescribas un archivo completo. SIEMPRE haz ediciones minimas y precisas sobre las lineas exactas que cambian.

## Formato de edicion (obligatorio)

### Para cambios pequenos (< 15 lineas): usa diff

### Archivo: \`ruta/del/archivo.ext\`
**Cambio:** [descripcion de 1 linea]

\`\`\`diff
- linea original exacta (copia literal del archivo)
- otra linea que se elimina
+ linea nueva que la reemplaza
+ otra linea nueva
\`\`\`

### Para bloques (funciones, clases, componentes): usa Search/Replace

### Archivo: \`ruta/del/archivo.ext\`
**Cambio:** [descripcion de 1 linea]

**Busca** (lineas ~N-M):
\`\`\`javascript
[codigo exacto actual con 2-3 lineas de contexto arriba y abajo]
\`\`\`

**Reemplaza por:**
\`\`\`javascript
[codigo nuevo]
\`\`\`

## Reglas de formato
- Solo muestra las lineas que cambian + 2-3 lineas de contexto
- Si hay multiples cambios en el mismo archivo, agrupalos bajo un solo header
- NUNCA pongas comentarios como "resto del codigo igual" o "[...]"
- Cuando insertes codigo nuevo, indica claramente: "Agrega DESPUES de la linea N:"
- Si el cambio afecta varios archivos, lista cada uno en orden de dependencia

## Flujo de analisis antes de editar
1. Identifica el/los archivo(s) donde esta el codigo relevante
2. Localiza la funcion/clase/bloque especifico
3. Propone el cambio minimo necesario
4. Explica en 1 linea el razonamiento

## Capacidades
- Edicion quirurgica en cualquier lenguaje
- Deteccion precisa de bugs (archivo + linea aproximada)
- Refactorizacion incremental sin romper dependencias
- Tests unitarios para funciones especificas
- Auditoria de seguridad con ubicacion exacta
- Analisis de rendimiento con mejoras concretas

## Respuesta
- Idioma: espanol, tono tecnico directo
- Sin emojis
- Sin archivos completos
- Sin texto de relleno`;
}

async function callGroq(messages, onChunk) {
  if (!S.groqKey) {
    throw new Error('No hay API key de Groq configurada. Ve a Configuracion (icono de engranaje) y agrega tu clave de console.groq.com');
  }

  const payload = {
    model: S.model || 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: buildSysPrompt() }, ...messages],
    temperature: 0.2,
    max_tokens: 4096,
    stream: !!onChunk,
  };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${S.groqKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Groq error ${res.status}`);
  }

  if (onChunk) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      for (const line of lines) {
        try {
          const data = JSON.parse(line.slice(6));
          const delta = data.choices?.[0]?.delta?.content || '';
          if (delta) { full += delta; onChunk(full); }
        } catch {}
      }
    }
    return full;
  } else {
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
}

async function callAI(msg, onChunk) {
  const msgs = [...S.history.slice(-14), { role: 'user', content: msg }];
  return callGroq(msgs, onChunk);
}

// ═══════════════════════════════════════════
// SMART FILE DISCOVERY
// ═══════════════════════════════════════════
function extractKeywords(msg) {
  const lower = msg.toLowerCase();
  const keywords = new Set();

  // Direct filename mentions
  const fileMatch = lower.match(/[\w-]+\.\w{1,6}/g) || [];
  fileMatch.forEach(m => { keywords.add(m); keywords.add(m.replace(/\.\w+$/, '')); });

  // Meaningful identifiers (camelCase, snake_case)
  const identifiers = lower.match(/[a-z][a-z0-9_]{2,}[A-Z][a-zA-Z]*/g) || [];
  identifiers.forEach(id => keywords.add(id.toLowerCase()));

  const stopWords = new Set([
    'el','la','los','las','de','del','en','un','una','que','por','para','con','sin',
    'como','pero','arregla','corrige','busca','mira','revisa','cambia','agrega','quita',
    'mueve','mejora','analiza','donde','esta','estan','esto','ese','esa','tiene','hace',
    'hacer','haz','debe','quiero','necesito','ayuda','todo','nada','algo','siempre',
    'nunca','archivo','codigo','funcion','clase','variable','este','esos','estas',
    'from','import','const','function','return','class','async','await','the','and',
    'this','that','with','have','been','would','could','should'
  ]);

  const words = lower.replace(/[^\w\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !stopWords.has(w));
  words.forEach(w => keywords.add(w));

  return [...keywords];
}

function scoreFile(filePath, keywords) {
  const parts = filePath.toLowerCase().split(/[\/\.\-\_]/);
  let score = 0;
  for (const kw of keywords) {
    for (const part of parts) {
      if (part === kw) score += 10;
      else if (part.includes(kw) && kw.length > 3) score += 5;
      else if (kw.includes(part) && part.length > 3) score += 3;
    }
  }
  // Boost important files
  if (/index|main|app|server|router|api/i.test(filePath)) score += 2;
  return score;
}

function scoreContent(content, keywords) {
  if (!content) return 0;
  const lower = content.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const count = (lower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'g')) || []).length;
    score += Math.min(count * 2, 12);
  }
  return score;
}

function pickKeyFiles(files) {
  const priority = /^(index|main|app|server|router|api)\.(js|ts|py|go|rb|php|jsx|tsx)$/i;
  const sorted = [...files].sort((a, b) => {
    const aKey = priority.test(a.path.split('/').pop()) ? 1 : 0;
    const bKey = priority.test(b.path.split('/').pop()) ? 1 : 0;
    return bKey - aKey;
  });
  return sorted;
}

async function findRelevantFiles(msg, maxFiles = 5) {
  if (!S.ok || !S.files.length) return [];
  const keywords = extractKeywords(msg);
  if (!keywords.length) return pickKeyFiles(S.files).slice(0, 2);

  // Phase 1: score by filename
  const scored = S.files.map(f => ({ f, score: scoreFile(f.path, keywords) }));
  scored.sort((a, b) => b.score - a.score);

  let candidates = scored.filter(x => x.score > 0).slice(0, 10).map(x => x.f);

  // Extension/category heuristics if nothing found
  if (!candidates.length) {
    const extMap = {
      style: ['.css','.scss','.sass','.less','.styl'],
      html: ['.html','.htm','.ejs','.hbs','.pug'],
      route: ['route','controller','handler','router'],
      model: ['model','schema','entity','type'],
      auth: ['auth','login','session','jwt','token','middleware'],
      api: ['api','endpoint','service','client','http'],
      test: ['.test.','.spec.','__test__','test_'],
      config: ['config','settings','env','.env'],
      db: ['database','db','migration','seed','query'],
    };
    const msgL = msg.toLowerCase();
    for (const [key, patterns] of Object.entries(extMap)) {
      if (msgL.includes(key)) {
        const matches = S.files.filter(f => patterns.some(p => f.path.toLowerCase().includes(p)));
        candidates.push(...matches.slice(0, 4));
      }
    }
  }

  if (!candidates.length) return pickKeyFiles(S.files).slice(0, 2);

  // Phase 2: fetch top candidates and score by content
  const withContent = [];
  const toFetch = candidates.slice(0, 6);
  const contents = await Promise.all(toFetch.map(f => fetchFile(f.path)));

  for (let i = 0; i < toFetch.length; i++) {
    const content = contents[i];
    const cs = content ? scoreContent(content, keywords) : 0;
    withContent.push({ f: toFetch[i], content, totalScore: scoreFile(toFetch[i].path, keywords) * 2 + cs });
  }
  withContent.sort((a, b) => b.totalScore - a.totalScore);

  return withContent.slice(0, maxFiles).map(x => ({ path: x.f.path, content: x.content }));
}

// ═══════════════════════════════════════════
// MULTI-AGENT FILE ANALYSIS
// ═══════════════════════════════════════════
async function multiAgentAnalyze(files, task) {
  if (!S.multiAgentEnabled || files.length <= 1) return null;

  const agentLogs = [];
  for (let i = 0; i < files.length; i++) {
    agentLogs.push(log('agent', `Agente ${i+1}: ${files[i].path.split('/').pop()}`, 'iniciando analisis...'));
  }

  // Run agents in parallel
  const results = await Promise.allSettled(files.map(async (file, idx) => {
    const content = file.content || await fetchFile(file.path);
    if (!content) return null;

    const lines = content.split('\n');
    const snippet = lines.length > 150 ? lines.slice(0, 150).join('\n') + `\n... [${lines.length - 150} lineas mas]` : content;

    const agentPrompt = `Tarea: ${task}

Analiza SOLO este archivo y determina:
1. Si este archivo es relevante para la tarea (si/no y por que)
2. Si es relevante: que cambios exactos se necesitan (en formato diff o Search/Replace)
3. Si no es relevante: di "ARCHIVO NO RELEVANTE"

### Archivo: \`${file.path}\`
\`\`\`
${snippet}
\`\`\`

Responde de forma concisa. Si el archivo no necesita cambios, di solo "ARCHIVO NO RELEVANTE para esta tarea".`;

    const r = await callGroq([{ role: 'user', content: agentPrompt }]);
    if (agentLogs[idx]) {
      const isRelevant = !r.includes('NO RELEVANTE');
      updateLastLog(isRelevant ? 'ok' : 'info', `Agente ${idx+1}: ${files[idx].path.split('/').pop()}`, isRelevant ? 'cambios encontrados' : 'sin cambios necesarios');
    }
    return { path: file.path, result: r, relevant: !r.includes('NO RELEVANTE') };
  }));

  return results
    .filter(r => r.status === 'fulfilled' && r.value && r.value.relevant)
    .map(r => r.value);
}

// ═══════════════════════════════════════════
// AUTO-ANALYZE
// ═══════════════════════════════════════════
async function autoAnalyze(codeCtx='') {
  if (!S.ok) return;
  if (!S.groqKey) { showToast('Configura tu API key de Groq primero'); openSettings(); return; }

  clearActivityLog();
  showActivity(true, 'Analizando repositorio...');
  log('run', 'Indexando estructura del proyecto', `${S.files.length} archivos`);

  // Fetch key files for context
  const keyFiles = pickKeyFiles(S.files).slice(0, 4);
  const keyContents = await Promise.all(keyFiles.map(f => fetchFile(f.path)));

  let fileContext = '';
  for (let i = 0; i < keyFiles.length; i++) {
    const content = keyContents[i];
    if (content) {
      const lines = content.split('\n');
      const snippet = lines.slice(0, 80).join('\n') + (lines.length > 80 ? '\n...' : '');
      fileContext += `\n\n### ${keyFiles[i].path}\n\`\`\`\n${snippet}\n\`\`\``;
      log('ok', `Leido: ${keyFiles[i].path}`, `${lines.length} lineas`);
    }
  }

  const prompt = `Analiza este repositorio de GitHub y genera un reporte tecnico completo.

Lista completa de archivos:
\`\`\`
${S.files.map(f=>f.path).join('\n')}
\`\`\`

Contenido de archivos clave:
${fileContext}

${codeCtx}

Responde con estas secciones:

## Descripcion del proyecto
[2-3 lineas]

## Stack tecnologico
[lista con version si es detectable]

## Arquitectura
[como esta organizado el codigo: carpetas principales y su funcion]

## Problemas criticos detectados
Para CADA problema: archivo exacto, linea aproximada, fragmento del codigo afectado, y edicion quirurgica para resolverlo (formato diff o Search/Replace).

## Mejora prioritaria recomendada
La mejora mas impactante. Muestra el codigo exacto a cambiar.`;

  const streamEl = mkStream();
  try {
    const result = await callAI(prompt, (text) => {
      updateLastLog('run', 'Generando analisis...', '');
      patchStream(streamEl, text);
    });
    updateLastLog('ok', 'Analisis completado', '');
    showActivity(false);
    finalStream(streamEl, result, [
      { label: 'Corregir todos los bugs', action: 'Encuentra y corrige TODOS los bugs detectados. Para cada bug: archivo, linea, descripcion del problema, y diff exacto del cambio.' },
      { label: 'Auditoria de seguridad', action: 'Auditoria OWASP Top 10 completa. Para cada vulnerabilidad: archivo afectado, codigo vulnerable (fragmento), y la correccion exacta en formato diff.' },
      { label: 'Optimizar rendimiento', action: 'Analiza y optimiza el rendimiento: N+1 queries, bundle size, async/await innecesario, memoizacion, caching. Muestra el codigo optimizado.' },
      { label: 'Refactorizar a mejores practicas', action: 'Refactoriza el codigo a las mejores practicas del stack. Solo cambios incrementales, sin reescribir archivos completos.' },
    ]);
    detectEditsAndShowPushBanner(result);
  } catch(e) {
    updateLastLog('err', 'Error', e.message);
    showActivity(false);
    finalStream(streamEl, `**Error:** ${e.message}`);
  }
}

// ═══════════════════════════════════════════
// DETECT EDITED FILES FROM AI RESPONSE
// ═══════════════════════════════════════════
function detectEditsAndShowPushBanner(text) {
  if (!S.ghToken || !S.repoData) return;
  const fileMatches = [...text.matchAll(/### Archivo:\s*[`']?([^\n`']+)[`']?/g)];
  if (fileMatches.length > 0) {
    const editedPaths = fileMatches.map(m => m[1].trim()).filter(p => S.files.some(f => f.path === p));
    if (editedPaths.length > 0) {
      showPushBanner(editedPaths);
    }
  }
}

// ═══════════════════════════════════════════
// SEND
// ═══════════════════════════════════════════
function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
}

async function send() {
  if (!S.groqKey) { showToast('Configura tu API key de Groq primero'); openSettings(); return; }

  const inp = document.getElementById('inp');
  const msg = inp.value.trim();
  if (!msg || S.busy) return;

  inp.value = ''; inp.style.height = 'auto';
  document.getElementById('sndbtn').disabled = true;
  S.busy = true;
  hidePushBanner();
  clearActivityLog();

  addMsg('me', msg);
  S.history.push({ role: 'user', content: msg });

  showActivity(true, 'Analizando tarea...');

  let enriched = msg;

  if (S.ok && S.files.length) {
    log('run', 'Buscando archivos relevantes', 'analisis semantico...');
    const relevant = await findRelevantFiles(msg, 5);

    if (relevant.length) {
      updateLastLog('ok', `${relevant.length} archivo(s) relevante(s) detectado(s)`, relevant.map(r => r.path.split('/').pop()).join(', '));

      let fileContext = '';

      if (S.multiAgentEnabled && relevant.length >= 2) {
        // Multi-agent: analyze files in parallel
        log('agent', `Lanzando ${relevant.length} agentes paralelos`, 'cada uno analiza un archivo');
        const agentResults = await multiAgentAnalyze(relevant, msg);

        if (agentResults && agentResults.length > 0) {
          log('ok', `${agentResults.length} agente(s) encontraron cambios relevantes`, agentResults.map(r => r.path.split('/').pop()).join(', '));
          // Build context from relevant results
          for (const ar of agentResults) {
            const content = ar.content || (await fetchFile(ar.path));
            if (content) {
              const lines = content.split('\n');
              const snippet = lines.length > 180 ? lines.slice(0, 180).join('\n') + `\n... [${lines.length-180} lineas mas]` : content;
              fileContext += `\n\n---\n### ARCHIVO: ${ar.path} [AGENTE: ${ar.result.slice(0,120)}]\n\`\`\`\n${snippet}\n\`\`\``;
            }
          }
        } else {
          // Fall back to standard context
          for (const r of relevant) {
            const content = r.content || await fetchFile(r.path);
            if (content) {
              log('ok', `Leido: ${r.path}`, `${content.split('\n').length} lineas`);
              const lines = content.split('\n');
              const snippet = lines.length > 180 ? lines.slice(0, 180).join('\n') + `\n... [${lines.length-180} lineas mas]` : content;
              fileContext += `\n\n---\n### ARCHIVO: ${r.path}\n\`\`\`\n${snippet}\n\`\`\``;
            }
          }
        }
      } else {
        // Standard: fetch and include files
        for (const r of relevant) {
          const content = r.content || await fetchFile(r.path);
          if (content) {
            log('run', `Leyendo ${r.path}`, `${content.split('\n').length} lineas`);
            const lines = content.split('\n');
            const snippet = lines.length > 200 ? lines.slice(0, 200).join('\n') + `\n... [${lines.length-200} lineas mas]` : content;
            fileContext += `\n\n---\n### ARCHIVO: ${r.path}\n\`\`\`\n${snippet}\n\`\`\``;
            updateLastLog('ok', `Leido: ${r.path}`, `${lines.length} lineas`);
          }
        }
      }

      if (fileContext) {
        enriched = `${msg}

## Contenido actual de los archivos relevantes
${fileContext}

## Instruccion
Ahora que tienes el codigo real, resuelve la tarea con ediciones quirurgicas. NO reescribas archivos completos. Usa formato diff (+/-) o Search/Replace mostrando SOLO las lineas que cambian con 2-3 lineas de contexto.`;
      }
    } else {
      log('info', 'Sin archivos especificos', 'respuesta general');
    }
  }

  log('run', 'Generando respuesta', `modelo: ${S.model}`);
  const streamEl = mkStream();
  let result = '';

  try {
    result = await callAI(enriched, (text) => {
      result = text;
      patchStream(streamEl, text);
    });

    finalStream(streamEl, result);
    updateLastLog('ok', 'Completado', '');
    showActivity(false);
    detectEditsAndShowPushBanner(result);
  } catch(e) {
    finalStream(streamEl, `**Error:** ${e.message}\n\nVerifica tu API key de Groq en Configuracion.`);
    updateLastLog('err', 'Error', e.message);
    showActivity(false);
  }

  S.busy = false;
  document.getElementById('sndbtn').disabled = false;
}

function doQuick(text) {
  if (S.busy) { showToast('El agente esta trabajando, espera...'); return; }
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
  showToast('Conversacion nueva');
}

// ═══════════════════════════════════════════
// FILE BROWSER
// ═══════════════════════════════════════════
let _filesOpen = false;
function toggleFiles() {
  _filesOpen = !_filesOpen;
  if (_filesOpen) showFileBrowser(); else closeFileBrowser();
}

function showFileBrowser() {
  let existing = document.getElementById('fbrowser');
  if (existing) { existing.style.display = 'flex'; return; }
  const el = document.createElement('div');
  el.id = 'fbrowser';
  el.style.cssText = `position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;background:var(--bg);padding-top:var(--safe-top)`;

  // Group files by directory
  const grouped = {};
  S.files.forEach(f => {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts[0] : '/';
    if (!grouped[dir]) grouped[dir] = [];
    grouped[dir].push(f);
  });

  let listHtml = '';
  for (const [dir, files] of Object.entries(grouped)) {
    listHtml += `<div style="padding:7px 14px 3px;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;background:var(--bg2);border-bottom:1px solid var(--border)">${esc(dir)}</div>`;
    files.forEach(f => {
      const name = f.path.split('/').pop();
      listHtml += `<div onclick="askAboutFile('${esc(f.path)}')" style="padding:8px 14px 8px 22px;font-family:var(--mono);font-size:11.5px;color:var(--text2);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:6px" onmouseenter="this.style.background='var(--bg2)'" onmouseleave="this.style.background=''">
        <span style="opacity:.4">&middot;</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
      </div>`;
    });
  }

  el.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg)">
    <span style="font-size:13px;font-weight:600;flex:1">Archivos (${S.files.length})</span>
    <button onclick="closeFileBrowser()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);border-radius:6px;cursor:pointer;font-size:12px;padding:4px 10px">Cerrar</button>
  </div><div style="flex:1;overflow-y:auto">${listHtml}</div>`;
  document.body.appendChild(el);
}

function closeFileBrowser() {
  _filesOpen = false;
  const el = document.getElementById('fbrowser');
  if (el) el.remove();
}

function askAboutFile(path) {
  closeFileBrowser();
  doQuick(`Lee el archivo \`${path}\` y analiza: que hace, si tiene bugs o codigo mejorable, y si detectas algo muestra el diff exacto del cambio sugerido.`);
}

// ═══════════════════════════════════════════
// KEYBOARD
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSheet();
    closeModal();
    closeSettings();
    closePushModal();
    closeFileBrowser();
  }
});

document.getElementById('modal').addEventListener('click', e => {
  if (e.target === document.getElementById('modal')) closeModal();
});
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('settings-modal')) closeSettings();
});
document.getElementById('push-modal').addEventListener('click', e => {
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
  }, 800);
}

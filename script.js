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
};

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
  updateSettingsBadges();
  updateModelPill();
}

function saveSettings() {
  const key = document.getElementById('set-groq').value.trim();
  const tok = document.getElementById('set-ghtoken').value.trim();
  const mdl = document.getElementById('set-model').value;
  const fl = document.getElementById('set-filelimit').value;

  if (!key) { showToast('La API key de Groq es requerida'); return; }

  localStorage.setItem('da_groq_key', key);
  localStorage.setItem('da_gh_token', tok);
  localStorage.setItem('da_model', mdl);
  localStorage.setItem('da_multi_agent', S.multiAgentEnabled ? 'true' : 'false');
  localStorage.setItem('da_plan_mode', S.planModeEnabled ? 'true' : 'false');
  localStorage.setItem('da_file_limit', fl);

  S.groqKey = key;
  S.ghToken = tok;
  S.model = mdl;
  S.fileLimit = parseInt(fl);

  updateSettingsBadges();
  updateModelPill();
  closeSettings();
  showToast('Configuracion guardada');
}

function updateSettingsBadges() {
  const groqOk = !!S.groqKey;
  document.getElementById('groq-badge').style.display = groqOk ? '' : 'none';
  document.getElementById('groq-warn').style.display = groqOk ? 'none' : '';
  document.getElementById('groq-sub').textContent = groqOk
    ? `Modelo: ${S.model}`
    : 'Haz clic para configurar tu API key de Groq (gratis)';
  const groqSa = document.getElementById('groq-sa-badge');
  if (groqSa) groqSa.style.display = groqOk ? '' : 'none';
}

function updateModelPill() {
  const el = document.getElementById('model-pill-txt');
  if (el) {
    const short = (S.model || '').replace('-versatile','').replace('-instruct','').replace('llama-','').replace('llama','');
    el.textContent = short || S.model;
  }
}

function openSettings() {
  document.getElementById('set-groq').value = S.groqKey || '';
  document.getElementById('set-ghtoken').value = S.ghToken || '';
  document.getElementById('set-model').value = S.model || 'llama-3.3-70b-versatile';
  document.getElementById('set-filelimit').value = String(S.fileLimit || 10);
  const tog = document.getElementById('multiagent-toggle');
  if (S.multiAgentEnabled) tog.classList.add('on'); else tog.classList.remove('on');
  const ptog = document.getElementById('planmode-toggle');
  if (S.planModeEnabled) ptog.classList.add('on'); else ptog.classList.remove('on');
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
function togglePlanMode() {
  S.planModeEnabled = !S.planModeEnabled;
  const tog = document.getElementById('planmode-toggle');
  if (S.planModeEnabled) tog.classList.add('on'); else tog.classList.remove('on');
}

// ═══════════════════════════════════════════
// SIDEBAR
// ═══════════════════════════════════════════
function toggleSidebar() {
  const s = document.getElementById('sidebar');
  const o = document.getElementById('sidebar-overlay');
  const isOpen = s.classList.contains('open');
  if (isOpen) {
    s.classList.remove('open');
    o.classList.remove('show');
  } else {
    s.classList.add('open');
    o.classList.add('show');
  }
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
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
  document.getElementById('modal-next').textContent = modalStep === 3 ? 'Listo' : 'Continuar';
  document.getElementById('modal-title').textContent = ['Conectar repositorio','Opciones avanzadas','Confirmacion'][modalStep-1];

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
        <div class="fh">Repositorios publicos funcionan sin token. Para privados, agrega tu GitHub Token en Configuracion.</div>
      </div>
      <div class="fg">
        <label class="fl">Rama</label>
        <input class="fi" type="text" id="repo-branch" placeholder="main" value="${S.branch}">
      </div>`;
    setTimeout(() => document.getElementById('repo-url')?.focus(), 100);
  } else if (modalStep === 2) {
    c.innerHTML = `
      <div class="fg">
        <label class="fl">Instrucciones del agente <span style="color:var(--text3);font-size:10px">opcional</span></label>
        <textarea class="fi" id="repo-inst" rows="4" placeholder="Ej: El proyecto usa TypeScript estricto. Los componentes van en src/components/. Siempre usa async/await.">${S.instructions}</textarea>
        <div class="fh">El agente usara estas instrucciones en todo el contexto de la sesion.</div>
      </div>
      <div id="modal-info" style="background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:13px;font-size:12px;color:var(--text2)">
        Cargando informacion del repositorio...
      </div>`;
    loadRepoInfo();
  } else {
    const r = S.repoData;
    c.innerHTML = `
      <div style="text-align:center;padding:14px 0">
        <div style="width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--purple));display:flex;align-items:center;justify-content:center;margin:0 auto 14px;box-shadow:0 8px 24px rgba(77,107,254,.25)">
          <svg width="24" height="24" viewBox="0 0 16 16" fill="white"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>
        </div>
        <div style="font-size:16px;font-weight:700;margin-bottom:5px">${r ? r.full_name : 'Repositorio'}</div>
        <div style="font-size:12px;color:var(--text2);max-width:280px;margin:0 auto">${r ? (r.description || 'Sin descripcion') : ''}</div>
        <div style="display:flex;justify-content:center;gap:20px;margin-top:16px;font-size:11.5px;color:var(--text3)">
          <span><strong style="color:var(--text)">${S.files.length}</strong> archivos indexados</span>
          <span><strong style="color:var(--text)">${r ? (r.language || 'multi-lang') : ''}</strong></span>
          <span>Rama: <strong style="color:var(--text)">${S.branch}</strong></span>
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
    if (!r.ok) throw new Error(`Error ${r.status} — el repo puede ser privado o la URL invalida`);
    const data = await r.json();
    if (info) info.innerHTML = `
      <div style="font-weight:600;color:var(--text);margin-bottom:5px;font-size:13px">${data.full_name}</div>
      <div style="margin-bottom:5px;color:var(--text2)">${data.description || 'Sin descripcion'}</div>
      <div style="margin-top:8px;display:flex;gap:14px;font-size:10.5px;flex-wrap:wrap">
        <span style="color:var(--text3)">Lenguaje: <strong style="color:var(--text2)">${data.language || 'varios'}</strong></span>
        <span style="color:var(--text3)">Stars: <strong style="color:var(--text2)">${data.stargazers_count}</strong></span>
        <span style="color:var(--text3)">Forks: <strong style="color:var(--text2)">${data.forks_count}</strong></span>
        <span style="color:var(--text3)">${data.private ? '🔒 Privado' : '🌐 Publico'}</span>
      </div>`;
  } catch(e) {
    if (info) info.innerHTML = `<span style="color:var(--red)">${esc(e.message)}</span>`;
  }
}

async function modalNext() {
  if (modalStep === 1) {
    const url = document.getElementById('repo-url').value.trim();
    const branch = document.getElementById('repo-branch').value.trim() || 'main';
    if (!url) { showToast('Ingresa la URL del repositorio'); return; }
    const match = url.match(/github\.com\/([^\/]+\/[^\/]+)/);
    if (!match) { showToast('URL invalida — usa el formato https://github.com/usuario/repo'); return; }
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
    fetch(`https://api.github.com/repos/${repo}`, { headers }).then(r => { if(!r.ok) throw new Error(`Repo no encontrado (${r.status})`); return r.json(); }),
    fetch(`https://api.github.com/repos/${repo}/git/trees/${S.branch}?recursive=1`, { headers }).then(r => { if(!r.ok) throw new Error(`No se pudo leer el arbol (${r.status})`); return r.json(); })
  ]);

  S.repoData = rData;
  const skipExts = /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|mp4|mp3|pdf|zip|gz|lock|bin|exe|dll)$/i;
  const skipDirs = /^(node_modules|\.git|dist|build|\.next|coverage|vendor|\.cache|\.parcel-cache)\//i;
  S.files = (treeData.tree || [])
    .filter(f => f.type === 'blob' && !skipExts.test(f.path) && !skipDirs.test(f.path))
    .map(f => ({ path: f.path, sha: f.sha }));

  S.ok = true;
  S.branch = rData.default_branch || S.branch;

  setChip(true, `${rData.name} (${S.files.length})`);
  document.getElementById('files-tbtn').style.display = '';
  const filesSa = document.getElementById('files-sa');
  if (filesSa) filesSa.style.display = '';
  document.getElementById('gh-ibtn').classList.add('gok');
  document.getElementById('gh-badge').style.display = '';
  document.getElementById('gh-sub').textContent = rData.full_name;
  document.getElementById('top-title').textContent = rData.full_name;
  const ghSaBadge = document.getElementById('gh-sa-badge');
  if (ghSaBadge) ghSaBadge.style.display = '';
  updateHistoryItem(rData.full_name);
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
    ? `1 archivo listo: ${editedFiles[0]}`
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
  const defaultMsg = `feat: update via DevAgent ${now.toISOString().slice(0,10)}`;
  document.getElementById('push-commit-msg').value = defaultMsg;
  document.getElementById('push-branch').value = S.branch;
  document.getElementById('push-result').style.display = 'none';
  document.getElementById('push-confirm-btn').disabled = false;
  document.getElementById('push-confirm-btn').textContent = 'Confirmar push';

  const list = document.getElementById('push-files-list');
  if (S.pendingEdits.length) {
    list.innerHTML = `<div style="font-size:10.5px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Archivos a subir (${S.pendingEdits.length})</div>` +
      S.pendingEdits.map(e => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span style="color:var(--green);font-weight:600;font-size:10px">MOD</span>
        <span style="font-family:var(--mono);color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.path)}</span>
      </div>`).join('');
  } else {
    list.innerHTML = `<div style="font-size:12px;color:var(--text3);padding:8px 0;line-height:1.6">No hay cambios pendientes detectados automaticamente. El agente genera ediciones en formato diff — aplicalas manualmente o usa el token con permisos <code>repo</code> para push automatico.</div>`;
  }
  document.getElementById('push-modal').classList.add('open');
}
function closePushModal() { document.getElementById('push-modal').classList.remove('open'); }

async function confirmPush() {
  if (!S.ghToken) { showToast('Configura un GitHub Token primero'); return; }
  if (!S.repoData) { showToast('No hay repositorio conectado'); return; }
  if (!S.pendingEdits.length) { showToast('No hay cambios pendientes para subir'); return; }

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
    result.innerHTML = `<div style="background:var(--gb);border:1px solid var(--gd);border-radius:var(--r);padding:11px 14px;font-size:12.5px;color:var(--green);font-weight:500">✓ ${pushed} archivo(s) subido(s) correctamente a <strong>${S.repoData.full_name}/${branch}</strong></div>`;
    S.pendingEdits = [];
    btn.textContent = 'Hecho';
    setTimeout(() => closePushModal(), 2200);
  } else {
    result.innerHTML = `<div style="background:var(--rb);border:1px solid rgba(248,113,113,.2);border-radius:var(--r);padding:11px 14px;font-size:12.5px;color:var(--red)">${pushed} subidos, ${errors.length} errores:<br><br>${errors.map(e=>`• ${esc(e)}`).join('<br>')}</div>`;
    btn.disabled = false;
    btn.textContent = 'Reintentar';
  }
}

// ═══════════════════════════════════════════
// SHEET
// ═══════════════════════════════════════════
function toggleSheet() { document.getElementById('so').classList.toggle('open'); }
function closeSheet() { document.getElementById('so').classList.remove('open'); }

// ═══════════════════════════════════════════
// EXPORT CONVERSATION
// ═══════════════════════════════════════════
function exportConversation() {
  const msgs = document.getElementById('msgs');
  if (!msgs || !msgs.children.length) { showToast('No hay mensajes para exportar'); return; }

  let md = `# Conversacion DevAgent\n\n`;
  if (S.repoData) md += `**Repositorio:** ${S.repoData.full_name}\n\n`;
  md += `**Fecha:** ${new Date().toLocaleString('es')}\n\n---\n\n`;

  Array.from(msgs.children).forEach(msg => {
    const isUser = msg.classList.contains('me');
    const body = msg.querySelector('.mbody');
    if (!body) return;
    const role = isUser ? '**Tu:**' : '**DevAgent:**';
    md += `${role}\n\n${body.innerText}\n\n---\n\n`;
  });

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devagent-${new Date().toISOString().slice(0,10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Conversacion exportada como Markdown');
}

// ═══════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════
function updateHistoryItem(name) {
  const el = document.getElementById('current-hist-item');
  if (el) el.querySelector('span').textContent = name;
}

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
  const chip = document.getElementById('schip');
  if (b) {
    dot.className = 'sdot busy';
    chip.className = 'status-chip busy';
    document.getElementById('act-head-txt').textContent = text;
    document.getElementById('sndbtn').style.display = 'none';
    document.getElementById('stopbtn').style.display = '';
  } else {
    dot.className = 'sdot' + (S.ok ? ' ok' : '');
    chip.className = 'status-chip' + (S.ok ? ' ok' : '');
    document.getElementById('sndbtn').style.display = '';
    document.getElementById('stopbtn').style.display = 'none';
  }
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
    const row = _logEntries[_logEntries.length - 1];
    row.innerHTML = `<div class="act-ic ${type}">${logIcon(type)}</div><div class="act-txt"><div class="act-title">${esc(title)}</div>${detail?`<div class="act-detail">${esc(detail)}</div>`:''}</div>`;
  }
}

function logIcon(type) {
  const icons = {
    run: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>`,
    ok: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`,
    err: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 8a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    info: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1116 0A8 8 0 010 8zm8-6.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM6.5 7.75A.75.75 0 017.25 7h1a.75.75 0 01.75.75v2.75h.25a.75.75 0 010 1.5h-2a.75.75 0 010-1.5h.25v-2h-.25a.75.75 0 01-.75-.75zM8 6a1 1 0 100-2 1 1 0 000 2z"/></svg>`,
    agent: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zM3.75 2a1.25 1.25 0 100 2.5A1.25 1.25 0 003.75 2zm6.5 1.25a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0zm2.25-1.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5zM0 12C0 9.51 2.01 8 4 8s4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 010 12.75V12zm4-2.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5zm8-2.5c2 0 4 1.51 4 4v.75a.75.75 0 01-.75.75h-6.5A.75.75 0 018 12.75V12c0-2.49 2.01-4 4-4zm0 1.5c-1.38 0-2.5 1.12-2.5 2.5v.25h5V12c0-1.38-1.12-2.5-2.5-2.5z"/></svg>`,
  };
  return icons[type] || icons.info;
}

function clearActivityLog() {
  document.getElementById('act-log').innerHTML = '';
  _logEntries = [];
}

let _toastT;
function showToast(t, type='') {
  const el = document.getElementById('toast');
  el.textContent = t;
  el.className = 'on' + (type ? ' ' + type : '');
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

  // Code blocks
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb' + Math.random().toString(36).slice(2,7);
    let rendered = code;
    const isDiff = lang === 'diff' || code.match(/^[+-]/m);
    if (isDiff) {
      rendered = code.split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${line}</span>`;
        if (line.startsWith('@@')) return `<span style="color:var(--accent);display:block;padding:0 4px;margin:0 -4px">${line}</span>`;
        return `<span class="diff-ctx">${line}</span>`;
      }).join('\n');
    }
    const applyBtn = isDiff ? `<button class="capply" onclick="applyDiff('${id}',this)" title="Marcar como aplicado">${checkIcon()} Aplicar</button>` : '';
    return `<div class="cblock"><div class="cblock-head"><span class="clang">${lang||'code'}</span><div class="cblock-btns">${applyBtn}<button class="ccopy" onclick="cpBlock('${id}',this)">${copyIcon()} Copiar</button></div></div><pre id="${id}">${rendered}</pre></div>`;
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
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/^(?!<[hulo]|<li|<hr|<div|<pre|<block)(.+)$/gm, '<p>$1</p>');
  s = s.replace(/<p><\/p>/g, '');

  return s;
}

function copyIcon() {
  return `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>`;
}
function checkIcon() {
  return `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg>`;
}

function cpBlock(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.innerText || el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.innerHTML = `${checkIcon()} Copiado`;
    btn.classList.add('done');
    setTimeout(() => { btn.innerHTML = `${copyIcon()} Copiar`; btn.classList.remove('done'); }, 2000);
  });
}

function applyDiff(id, btn) {
  btn.innerHTML = `${checkIcon()} Aplicado`;
  btn.classList.add('done');
  showToast('Marca el diff como aplicado en tu editor');
}

// ═══════════════════════════════════════════
// CHAT MESSAGES
// ═══════════════════════════════════════════
function addMsg(role, text, opts={}) {
  const msgs = document.getElementById('msgs');
  document.getElementById('empty').classList.add('gone');

  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const isAI = role === 'ai';
  const avatarTxt = isAI ? 'DA' : 'Tu';

  div.innerHTML = `
    <div class="msg-head">
      <div class="av ${role}">${avatarTxt}</div>
      <span class="mname">${isAI ? 'DevAgent' : 'Tu'}</span>
      <span class="mtime">${now()}</span>
      <div class="msg-actions-row">
        <button class="msg-action" onclick="copyMsgText(this)" title="Copiar mensaje">
          ${copyIcon()} Copiar
        </button>
        ${isAI ? `<button class="msg-action" onclick="regenerateMsg(this)" title="Regenerar">
          <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
          Regenerar
        </button>` : ''}
      </div>
    </div>
    <div class="mbody">${isAI ? md(text) : `<p>${esc(text)}</p>`}</div>
  `;

  if (opts.chips && opts.chips.length) {
    const chipsDiv = document.createElement('div');
    chipsDiv.className = 'chips';
    opts.chips.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.textContent = c.label;
      btn.onclick = () => doQuick(c.action);
      chipsDiv.appendChild(btn);
    });
    div.appendChild(chipsDiv);
  }

  msgs.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function copyMsgText(btn) {
  const msg = btn.closest('.msg');
  const body = msg?.querySelector('.mbody');
  if (!body) return;
  navigator.clipboard.writeText(body.innerText || body.textContent).then(() => {
    showToast('Mensaje copiado');
  });
}

function regenerateMsg(btn) {
  const lastUserMsg = [...document.querySelectorAll('.msg.me .mbody p')].pop();
  if (!lastUserMsg) { showToast('No hay mensaje para regenerar'); return; }
  const text = lastUserMsg.textContent;
  const msgs = document.getElementById('msgs');
  const lastAi = [...msgs.querySelectorAll('.msg.ai')].pop();
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
    <div class="msg-head">
      <div class="av ai">DA</div>
      <span class="mname">DevAgent</span>
      <span class="mtime">${now()}</span>
    </div>
    <div class="mbody thinking-row"><div class="dots"><span></span><span></span><span></span></div><span style="margin-left:4px">Generando...</span></div>
  `;
  msgs.appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

function patchStream(div, text) {
  const body = div.querySelector('.mbody');
  if (!body) return;
  body.innerHTML = md(text) + '<span class="scursor"></span>';
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function finalStream(div, text) {
  const body = div.querySelector('.mbody');
  if (!body) return;
  body.innerHTML = md(text);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'msg-head';
  actionsRow.style.cssText = 'margin-top:8px;justify-content:flex-end';
  actionsRow.innerHTML = `
    <button class="msg-action" onclick="copyMsgText(this)" title="Copiar">
      ${copyIcon()} Copiar
    </button>
    <button class="msg-action" onclick="regenerateMsg(this)" title="Regenerar">
      <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
      Regenerar
    </button>
  `;
  div.appendChild(actionsRow);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// ═══════════════════════════════════════════
// GROQ API
// ═══════════════════════════════════════════
async function callAI(msg, onStream) {
  if (!S.groqKey) throw new Error('No hay API key de Groq configurada. Ve a Configuracion.');

  const systemPrompt = buildSystemPrompt();
  const messages = [
    { role: 'system', content: systemPrompt },
    ...S.history.slice(-12),
    { role: 'user', content: msg }
  ];

  S.abortController = new AbortController();

  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${S.groqKey}`,
      'Content-Type': 'application/json'
    },
    signal: S.abortController.signal,
    body: JSON.stringify({
      model: S.model,
      messages,
      max_tokens: 8192,
      temperature: 0.2,
      stream: true
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Error Groq API: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    const lines = chunk.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        result += delta;
        if (onStream) onStream(result);
      } catch {}
    }
  }

  S.history.push({ role: 'user', content: msg });
  S.history.push({ role: 'assistant', content: result });

  return result;
}

function buildSystemPrompt() {
  let sys = `Eres DevAgent, un agente de desarrollo de software autonomo y experto. Eres la fusion de las capacidades de GitHub Copilot, Codex y Claude Code.

CAPACIDADES PRINCIPALES:
- Analisis profundo de repositorios y codebases completas
- Deteccion y correccion quirurgica de bugs
- Auditorias de seguridad (OWASP Top 10)
- Optimizacion de rendimiento
- Refactorizacion con principios SOLID, DRY, YAGNI
- Generacion de tests unitarios e integracion
- Documentacion tecnica completa
- Migraciones de frameworks y actualizacion de dependencias

REGLAS DE EDICION (CRITICAS):
1. NUNCA reescribas archivos completos. Usa SIEMPRE ediciones quirurgicas
2. Para cambios de codigo usa formato diff exacto:
   \`\`\`diff
   --- a/archivo.js
   +++ b/archivo.js
   @@ -10,7 +10,7 @@
   - linea original
   + linea nueva con el fix
   \`\`\`
3. Incluye 2-3 lineas de contexto alrededor de cada cambio
4. Para codigo nuevo usa bloques con el nombre del archivo
5. Explica SIEMPRE el razonamiento del cambio

FORMATO DE RESPUESTAS:
- Usa markdown rico: headers, bold, listas, code blocks
- Para bugs: archivo → linea → descripcion → diff
- Para analisis: resumen ejecutivo → problemas criticos → recomendaciones
- Sé conciso pero completo. No rellenes con texto innecesario.`;

  if (S.repoData) {
    sys += `\n\nREPOSITORIO ACTIVO: ${S.repoData.full_name}
Lenguaje principal: ${S.repoData.language || 'varios'}
Rama: ${S.branch}
Archivos indexados: ${S.files.length}`;
  }

  if (S.instructions) {
    sys += `\n\nINSTRUCCIONES DEL USUARIO (maxima prioridad):\n${S.instructions}`;
  }

  if (S.planModeEnabled) {
    sys += `\n\nMODO PLAN ACTIVO: Antes de implementar cualquier cambio, presenta un plan numerado con los pasos que vas a seguir. Espera confirmacion del usuario antes de proceder con el codigo.`;
  }

  return sys;
}

// ═══════════════════════════════════════════
// FILE RELEVANCE
// ═══════════════════════════════════════════
function findRelevantFiles(msg) {
  if (!S.files.length) return [];
  const lower = msg.toLowerCase();
  const scored = S.files.map(f => {
    let score = 0;
    const pathLower = f.path.toLowerCase();

    const pathParts = f.path.toLowerCase().split('/');
    const fileName = pathParts[pathParts.length - 1];

    // Direct mention
    if (lower.includes(f.path.toLowerCase())) score += 100;
    if (lower.includes(fileName.replace(/\.\w+$/, ''))) score += 40;

    // Keyword matching
    const keywords = {
      auth: ['auth', 'login', 'session', 'token', 'jwt', 'password', 'usuario'],
      db: ['database', 'db', 'modelo', 'schema', 'migration', 'query', 'sql'],
      api: ['api', 'route', 'endpoint', 'controller', 'handler', 'rest'],
      ui: ['component', 'view', 'page', 'template', 'style', 'css', 'ui'],
      test: ['test', 'spec', 'jest', 'mocha'],
      config: ['config', 'env', 'settings', 'webpack', 'vite'],
      main: ['main', 'index', 'app', 'server', 'entry'],
    };

    for (const [cat, words] of Object.entries(keywords)) {
      if (words.some(w => lower.includes(w)) && words.some(w => pathLower.includes(w))) {
        score += 25;
      }
    }

    // Extension matching
    const codeExts = ['.js','.ts','.jsx','.tsx','.py','.go','.rs','.java','.php','.rb','.cs','.cpp','.c','.h'];
    if (codeExts.some(e => pathLower.endsWith(e))) score += 5;

    // Important files get a boost
    const important = ['package.json','requirements.txt','go.mod','cargo.toml','index.js','app.js','main.py','server.js','main.ts','app.ts'];
    if (important.some(i => fileName === i)) score += 15;

    return { ...f, score };
  });

  return scored
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, S.fileLimit);
}

function detectEditsAndShowPushBanner(text) {
  if (!S.repoData || !S.ghToken) return;
  const diffMatches = text.match(/```diff[\s\S]*?```/g) || [];
  if (!diffMatches.length) return;

  const editedFiles = [];
  diffMatches.forEach(block => {
    const fileMatch = block.match(/--- a\/(.+)/);
    if (fileMatch) {
      const path = fileMatch[1].trim();
      if (!editedFiles.includes(path)) editedFiles.push(path);
      if (!S.pendingEdits.find(e => e.path === path)) {
        S.pendingEdits.push({ path, newContent: '', originalContent: '' });
      }
    }
  });

  if (editedFiles.length) {
    showPushBanner(editedFiles);
  }
}

// ═══════════════════════════════════════════
// AUTO ANALYZE
// ═══════════════════════════════════════════
function autoAnalyze() {
  const chips = [
    { label: 'Analizar arquitectura', action: 'Analiza el repositorio completo: arquitectura, stack, dependencias y problemas criticos.' },
    { label: 'Buscar bugs', action: 'Detecta y corrige todos los bugs del proyecto con diffs exactos.' },
    { label: 'Auditoria de seguridad', action: 'Haz una auditoria de seguridad OWASP completa del proyecto.' },
    { label: 'Optimizar rendimiento', action: 'Analiza y optimiza el rendimiento del proyecto.' },
    { label: 'Generar tests', action: 'Genera tests unitarios completos para el proyecto.' },
  ];
  addMsg('ai', `✓ Repositorio **${S.repoData.full_name}** conectado con **${S.files.length} archivos** indexados en la rama **${S.branch}**.\n\n¿Que quieres hacer con el repositorio?`, { chips });
}

// ═══════════════════════════════════════════
// STOP GENERATION
// ═══════════════════════════════════════════
function stopGeneration() {
  if (S.abortController) {
    S.abortController.abort();
    S.abortController = null;
    showToast('Generacion detenida');
  }
}

// ═══════════════════════════════════════════
// SEND
// ═══════════════════════════════════════════
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
    showToast('Configura tu API key de Groq primero — es gratis');
    openSettings();
    return;
  }

  S.busy = true;
  inp.value = '';
  inp.style.height = 'auto';
  document.getElementById('sndbtn').disabled = true;
  document.getElementById('char-count').textContent = '';

  addMsg('me', msg);
  clearActivityLog();
  showActivity(true, 'Procesando tarea...');

  let enriched = msg;

  if (S.repoData && S.files.length) {
    const relevant = findRelevantFiles(msg);

    if (relevant.length) {
      log('info', `Analizando ${relevant.length} archivos relevantes`, relevant.slice(0,3).map(f=>f.path).join(', '));

      let fileContext = '';
      for (const r of relevant) {
        const content = await fetchFile(r.path);
        if (content) {
          const lines = content.split('\n');
          log('run', `Leyendo ${r.path}`, `${lines.length} lineas`);
          const snippet = lines.length > 200 ? lines.slice(0, 200).join('\n') + `\n... [${lines.length-200} lineas mas, truncado]` : content;
          fileContext += `\n\n---\n### ARCHIVO: ${r.path}\n\`\`\`\n${snippet}\n\`\`\``;
          updateLastLog('ok', `Leido: ${r.path}`, `${lines.length} lineas`);
        }
      }

      if (fileContext) {
        enriched = `${msg}\n\n## Contenido de archivos relevantes del repositorio\n${fileContext}\n\n## Instruccion\nCon el codigo real de arriba, resuelve la tarea. Usa ediciones quirurgicas con formato diff exacto. NO reescribas archivos completos.`;
      }
    } else {
      log('info', 'Usando contexto general del repo', `${S.files.length} archivos disponibles`);
      const fileList = S.files.slice(0, 80).map(f => f.path).join('\n');
      enriched = `${msg}\n\n## Estructura del repositorio (${S.files.length} archivos)\n\`\`\`\n${fileList}\n\`\`\``;
    }
  }

  log('run', 'Enviando al modelo de IA', S.model);
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
    if (e.name === 'AbortError') {
      finalStream(streamEl, result || '_Generacion detenida por el usuario._');
      showActivity(false);
    } else {
      finalStream(streamEl, `**Error:** ${e.message}\n\n${!S.groqKey ? 'Ve a **Configuracion** y agrega tu API key de Groq (gratis en console.groq.com).' : 'Verifica tu API key en Configuracion.'}`);
      updateLastLog('err', 'Error', e.message);
      showActivity(false);
    }
  }

  S.busy = false;
  S.abortController = null;
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
  document.getElementById('top-title').textContent = 'DevAgent — Agente de codigo autonomo';
  showToast('Conversacion nueva');
  closeSidebar();
}

// ═══════════════════════════════════════════
// INPUT TEMPLATES
// ═══════════════════════════════════════════
function insertCodeTemplate() {
  const inp = document.getElementById('inp');
  const tmpl = 'Modifica el archivo `ARCHIVO` para que `FUNCION` haga lo siguiente: ';
  inp.value = tmpl;
  inp.focus();
  inp.setSelectionRange(19, 26);
  document.getElementById('sndbtn').disabled = false;
}

function insertPlanTemplate() {
  const inp = document.getElementById('inp');
  const tmpl = 'Crea un plan detallado paso a paso para implementar: ';
  inp.value = tmpl;
  inp.focus();
  inp.setSelectionRange(tmpl.length, tmpl.length);
  document.getElementById('sndbtn').disabled = false;
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

  const grouped = {};
  S.files.forEach(f => {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, parts.length-1).join('/') : '/';
    if (!grouped[dir]) grouped[dir] = [];
    grouped[dir].push(f);
  });

  const extIcon = (path) => {
    const ext = path.split('.').pop().toLowerCase();
    const colors = { js:'#f7df1e', ts:'#3178c6', jsx:'#61dafb', tsx:'#61dafb', py:'#3572a5', go:'#00add8', rs:'#dea584', css:'#563d7c', html:'#e34c26', json:'#292929', md:'#083fa1' };
    const col = colors[ext] || '#4B5563';
    return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col};flex-shrink:0"></span>`;
  };

  let searchHtml = `<div style="padding:10px 14px;border-bottom:1px solid var(--border)"><input id="fb-search" type="text" placeholder="Buscar archivo..." style="width:100%;padding:8px 12px;background:var(--bg3);border:1px solid var(--border2);border-radius:var(--r);color:var(--text);font:inherit;font-size:13px;outline:none" oninput="filterFiles(this.value)"></div>`;

  let listHtml = '';
  for (const [dir, files] of Object.entries(grouped)) {
    listHtml += `<div class="fb-dir-group" data-dir="${esc(dir)}">
      <div style="padding:7px 14px 3px;font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.6px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11" style="color:var(--text3)"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3h-6.5L5.987 1.755A1.75 1.75 0 004.744 1H1.75z"/></svg>
        ${esc(dir)}
      </div>`;
    files.forEach(f => {
      const name = f.path.split('/').pop();
      listHtml += `<div class="fb-file" data-path="${esc(f.path)}" onclick="askAboutFile('${esc(f.path)}')" style="padding:8px 14px 8px 24px;font-family:var(--mono);font-size:11.5px;color:var(--text2);border-bottom:1px solid var(--border);cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .1s" onmouseenter="this.style.background='var(--bg3)'" onmouseleave="this.style.background=''">
        ${extIcon(f.path)}
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        <span style="color:var(--text3);font-size:9.5px;flex-shrink:0">${esc(f.path.includes('/') ? f.path.split('/').slice(0,-1).join('/') : '')}</span>
      </div>`;
    });
    listHtml += `</div>`;
  }

  el.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
    <span style="font-size:13px;font-weight:700;flex:1">Archivos del repositorio <span style="font-size:11px;color:var(--text3);font-weight:400">(${S.files.length})</span></span>
    <button onclick="closeFileBrowser()" style="background:var(--bg4);border:1px solid var(--border2);color:var(--text2);border-radius:7px;cursor:pointer;font-size:12px;padding:5px 12px;font-family:inherit">Cerrar</button>
  </div>${searchHtml}<div id="fb-list" style="flex:1;overflow-y:auto">${listHtml}</div>
  <div style="padding:8px 14px;background:var(--bg2);border-top:1px solid var(--border);font-size:11px;color:var(--text3)">Clic en un archivo para que el agente lo analice</div>`;

  document.body.appendChild(el);
}

function filterFiles(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('.fb-file').forEach(el => {
    const path = el.getAttribute('data-path') || '';
    el.style.display = path.toLowerCase().includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.fb-dir-group').forEach(el => {
    const visible = [...el.querySelectorAll('.fb-file')].some(f => f.style.display !== 'none');
    el.style.display = visible ? '' : 'none';
  });
}

function closeFileBrowser() {
  _filesOpen = false;
  const el = document.getElementById('fbrowser');
  if (el) el.remove();
}

function askAboutFile(path) {
  closeFileBrowser();
  doQuick(`Analiza el archivo \`${path}\`: que hace, que patrones usa, si tiene bugs o problemas de calidad, y si encuentras algo muestra el diff exacto del cambio sugerido.`);
}

// ═══════════════════════════════════════════
// KEYBOARD SHORTCUTS
// ═══════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSheet();
    closeModal();
    closeSettings();
    closePushModal();
    closeFileBrowser();
    closeSidebar();
  }
  // Cmd/Ctrl+K = nueva conversacion
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    clearChat();
  }
  // Cmd/Ctrl+, = settings
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    openSettings();
  }
  // Cmd/Ctrl+E = exportar
  if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
    e.preventDefault();
    exportConversation();
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
  this.style.height = Math.min(this.scrollHeight, 180) + 'px';
  const len = this.value.trim().length;
  document.getElementById('sndbtn').disabled = !len || S.busy;
  const cc = document.getElementById('char-count');
  if (cc) cc.textContent = len > 0 ? `${len} chars` : '';
});

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
loadSettings();

if (!S.groqKey) {
  setTimeout(() => {
    showToast('Bienvenido a DevAgent — Configura tu API key de Groq para comenzar (es gratis)');
    setTimeout(() => openSettings(), 500);
  }, 1000);
}

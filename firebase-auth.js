// ═══════════════════════════════════════════════════════
// firebase-auth.js
// Autenticacion Firebase (email/password) + persistencia
// de settings y ultimo repo en Realtime Database.
// Se carga ANTES que script.js para que el app espere
// al usuario antes de inicializar la sesion del agente.
// ═══════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyC9v2qp6zGtmvsFiOknlmTHnN6zZY1RLcI",
  authDomain: "ggggg-f2508.firebaseapp.com",
  databaseURL: "https://ggggg-f2508-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ggggg-f2508",
  storageBucket: "ggggg-f2508.firebasestorage.app",
  messagingSenderId: "120837533638",
  appId: "1:120837533638:web:6720ebd1367f3acf9f4cc7",
  measurementId: "G-E2JX3ZGG5K"
};

firebase.initializeApp(firebaseConfig);

const _fbAuth = firebase.auth();
const _fbDb   = firebase.database();

let _fbUser = null;

// ── Overlay helpers ───────────────────────
function _showAuth() {
  const el = document.getElementById('auth-overlay');
  if (el) el.classList.add('visible');
}
function _hideAuth() {
  const el = document.getElementById('auth-overlay');
  if (el) el.classList.remove('visible');
}
function _setAuthErr(msg) {
  const el = document.getElementById('auth-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}
function _setAuthLoading(on) {
  const btn = document.getElementById('auth-submit-btn');
  if (!btn) return;
  btn.disabled = on;
  btn.textContent = on ? 'Un momento...'
    : (window._authMode === 'register' ? 'Crear cuenta' : 'Entrar');
}

// ── Modo login/registro ───────────────────
window._authMode = 'login';

window.switchAuthMode = function(mode) {
  window._authMode = mode;
  _setAuthErr('');
  const lt = document.getElementById('auth-tab-login');
  const rt = document.getElementById('auth-tab-register');
  const btn = document.getElementById('auth-submit-btn');
  const nw  = document.getElementById('auth-name-wrap');
  if (mode === 'login') {
    lt?.classList.add('active');
    rt?.classList.remove('active');
    if (btn) btn.textContent = 'Entrar';
    if (nw)  nw.style.display = 'none';
  } else {
    rt?.classList.add('active');
    lt?.classList.remove('active');
    if (btn) btn.textContent = 'Crear cuenta';
    if (nw)  nw.style.display = '';
  }
};

window.submitAuth = async function() {
  const email = document.getElementById('auth-email')?.value?.trim();
  const pass  = document.getElementById('auth-password')?.value;
  _setAuthErr('');
  if (!email || !pass) { _setAuthErr('Completa todos los campos'); return; }
  if (pass.length < 6) { _setAuthErr('La contraseña debe tener al menos 6 caracteres'); return; }

  _setAuthLoading(true);
  try {
    if (window._authMode === 'register') {
      await _fbAuth.createUserWithEmailAndPassword(email, pass);
    } else {
      await _fbAuth.signInWithEmailAndPassword(email, pass);
    }
  } catch (e) {
    const msgs = {
      'auth/email-already-in-use': 'Ya existe una cuenta con ese email',
      'auth/user-not-found': 'No existe una cuenta con ese email',
      'auth/wrong-password': 'Contraseña incorrecta',
      'auth/invalid-email': 'Email inválido',
      'auth/too-many-requests': 'Demasiados intentos, intenta más tarde',
      'auth/invalid-credential': 'Email o contraseña incorrectos',
      'auth/network-request-failed': 'Sin conexión a internet',
    };
    _setAuthErr(msgs[e.code] || e.message);
    _setAuthLoading(false);
  }
  // Si fue exitoso, onAuthStateChanged se encarga; no llamamos setAuthLoading(false) aqui
};

window.logoutFirebase = async function() {
  try {
    await _fbAuth.signOut();
  } catch(e) { console.warn('[firebase] signOut error:', e.message); }
};

// ── Realtime Database ─────────────────────
async function _saveUserData(data) {
  if (!_fbUser) return;
  try {
    // Filtrar undefined para que Firebase no los rechace
    const clean = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined && v !== null)
    );
    await _fbDb.ref(`users/${_fbUser.uid}/settings`).update(clean);
  } catch (e) { console.warn('[firebase] saveUserData:', e.message); }
}

async function _saveLastRepo(repo) {
  if (!_fbUser) return;
  try {
    await _fbDb.ref(`users/${_fbUser.uid}/lastRepo`).set(repo);
  } catch (e) { console.warn('[firebase] saveLastRepo:', e.message); }
}

async function _loadUserData() {
  if (!_fbUser) return null;
  try {
    const snap = await _fbDb.ref(`users/${_fbUser.uid}`).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) { console.warn('[firebase] loadUserData:', e.message); return null; }
}

// Aplica datos de Firebase a localStorage para que loadSettings() los lea
function _applyToLocalStorage(data) {
  if (!data) return;
  const s = data.settings || {};
  if (s.ghToken      !== undefined) localStorage.setItem('da_gh_token',     s.ghToken);
  if (s.model        !== undefined) localStorage.setItem('da_model',        s.model);
  if (s.multiAgentEnabled !== undefined) localStorage.setItem('da_multi_agent', s.multiAgentEnabled ? 'true' : 'false');
  if (s.planModeEnabled   !== undefined) localStorage.setItem('da_plan_mode',   s.planModeEnabled   ? 'true' : 'false');
  // Guardar ultimo repo en window para auto-reconexion
  window._fbLastRepo = data.lastRepo || null;
}

// ── Observer de estado de auth ────────────
_fbAuth.onAuthStateChanged(async (user) => {
  _fbUser = user;

  if (user) {
    // Cargar datos del usuario y sincronizar localStorage
    const data = await _loadUserData();
    _applyToLocalStorage(data);
    _hideAuth();
    // Avisar a script.js que puede inicializar el agente
    if (typeof window.onFirebaseAuthReady === 'function') {
      window.onFirebaseAuthReady(user);
    }
  } else {
    window._fbLastRepo = null;
    _showAuth();
    window.switchAuthMode('login');
  }
});

// ── API pública ───────────────────────────
window.FB = {
  get currentUser() { return _fbUser; },
  saveUserData: _saveUserData,
  saveLastRepo: _saveLastRepo,
  loadUserData: _loadUserData,
};

// ═══════════════════════════════════════════════════════
// computerUse.js
// "Juicio visual" estilo GPT-6 Astra: un navegador Chromium REAL
// que el agente puede VER (capturas de pantalla) y CONTROLAR
// (clics, escritura, scroll, teclas, navegación) mediante el
// protocolo CDP (Chrome DevTools Protocol).
//
// Arquitectura:
//  - Un Chromium headless por sesión, con perfil fresco y aislado
//    (sin credenciales guardadas, sin acceso al perfil del usuario).
//  - observe(): captura JPEG + árbol de accesibilidad simplificado
//    (elementos interactivos con coordenadas reales) + url/título.
//  - act(accion): click / type / press / scroll / navigate / wait.
//  - El bucle de decisión vive en chatRoutes (usa el modelo de
//    texto con el árbol de accesibilidad y el modelo de visión
//    con las capturas cuando está disponible).
//
// Seguridad: el navegador corre con --no-sandbox en el servidor,
// perfil temporal por sesión que se borra al expirar la sesión.
// ═══════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

const CHROME_BIN = process.env.AGENT_CHROME_BIN || '/opt/meta-chromium/chrome';
const VIEWPORT = { width: 1280, height: 800 };
const MAX_ELEMENTS = 60;

// ─────────────────────────────────────────────────────────
// Mini-proxy local de salida.
// El servidor sale a internet por un proxy con autenticación
// (variables https_proxy/http_proxy). Chromium no sabe leer
// esas variables ni pedir credenciales solo, así que se
// levanta este reenviador en 127.0.0.1 que inyecta la cabecera
// Proxy-Authorization y Chromium lo usa SIN autenticación.
// Se cierra junto con el navegador.
// ─────────────────────────────────────────────────────────
function startEgressProxy() {
  const egress = pickEgressProxy();
  if (!egress) return Promise.resolve(null);
  const authHeader = 'Basic ' + Buffer.from(`${egress.username}:${egress.password}`).toString('base64');
  // Todos los sockets vivos: al cerrar se destruyen para que
  // server.close() no espere conexiones abiertas (evita ~60s de cuelgue).
  const sockets = new Set();

  // Reenviador TCP: lee el bloque de cabeceras, inyecta
  // Proxy-Authorization y lo pasa al proxy de salida.
  // Maneja CONNECT (HTTPS) y peticiones HTTP con URL absoluta.
  // Fuerza "Connection: close" para que cada petición abra una
  // conexión nueva y siempre lleve la autenticación inyectada.
  const server = net.createServer((clientSocket) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    let headBuf = Buffer.alloc(0);
    const onData = (chunk) => {
      headBuf = Buffer.concat([headBuf, chunk]);
      const idx = headBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      clientSocket.removeListener('data', onData);
      const head = headBuf.slice(0, idx).toString('latin1');
      const rest = headBuf.slice(idx + 4);
      const lines = head.split('\r\n');
      const firstLine = lines[0] || '';
      const isConnect = /^CONNECT\s/i.test(firstLine);

      const upstream = net.connect(Number(egress.port), egress.host, () => {
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));        if (isConnect) {
          const target = (firstLine.split(' ')[1] || '').trim();
          upstream.write(
            `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
            `Proxy-Authorization: ${authHeader}\r\nProxy-Connection: keep-alive\r\n\r\n`
          );
          let resp = '';
          const onResp = (c) => {
            resp += c.toString('latin1');
            if (!resp.includes('\r\n\r\n')) return;
            upstream.removeListener('data', onResp);
            if (/^HTTP\/1\.[01] 200/i.test(resp)) {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
              upstream.pipe(clientSocket);
              clientSocket.pipe(upstream);
            } else {
              try { clientSocket.destroy(); } catch {}
              try { upstream.destroy(); } catch {}
            }
          };
          upstream.on('data', onResp);
        } else {
          const out = [firstLine];
          let hasAuth = false;
          for (let i = 1; i < lines.length; i++) {
            const ln = lines[i];
            if (/^proxy-authorization:/i.test(ln)) { out.push(`Proxy-Authorization: ${authHeader}`); hasAuth = true; }
            else if (/^(proxy-)?connection:/i.test(ln)) out.push('Connection: close');
            else out.push(ln);
          }
          if (!hasAuth) out.push(`Proxy-Authorization: ${authHeader}`);
          out.push('Connection: close');
          upstream.write(out.join('\r\n') + '\r\n\r\n');
          if (rest.length) upstream.write(rest);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        }
      });
      const onErr = () => { try { clientSocket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
      upstream.on('error', onErr);
      clientSocket.on('error', onErr);
      setTimeout(() => {
        try { clientSocket.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
      }, 60000).unref?.();
    };
    clientSocket.on('data', onData);
    clientSocket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const s of sockets) { try { s.destroy(); } catch {} }
          sockets.clear();
          server.close(r);
        }),
      });
    });
  });
}

// ─────────────────────────────────────────────────────────
// Cliente CDP mínimo sobre WebSocket: envía un comando y
// espera su respuesta por id. Sin dependencias pesadas.
// ─────────────────────────────────────────────────────────
class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.ws = null;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP: timeout conectando')), timeoutMs);
      this.ws = new WebSocket(this.url, { maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', () => { clearTimeout(timer); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      this.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`CDP ${msg.error.message || 'error'}`));
          else res(msg.result || {});
        }
      });
      this.ws.on('close', () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error('CDP: conexión cerrada'));
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('CDP: no conectado'));
      }
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP: timeout en ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws && this.ws.close(); } catch {}
  }
}

// Lee el proxy de salida del entorno (https_proxy/http_proxy con
// credenciales user:pass@host:port). Sin esto, el Chromium del
// agente no tiene internet en este servidor.
function pickEgressProxy() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY || '';
  const m = raw.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)/);
  if (!m) return null;
  return { username: m[1], password: m[2], host: m[3], port: m[4] };
}

// ─────────────────────────────────────────────────────────
// Navegador del agente
// ─────────────────────────────────────────────────────────
class AgentBrowser {
  constructor(sessionDir) {
    this.sessionDir = sessionDir;
    this.profileDir = path.join(sessionDir, 'browser-profile');
    this.proc = null;
    this.cdp = null;
    this.debugPort = null;
    this.elementIndex = new Map(); // id -> { backendNodeId, x, y, role, name }
  }

  async launch() {
    fs.mkdirSync(this.profileDir, { recursive: true });
    if (!fs.existsSync(CHROME_BIN)) {
      throw new Error(`No se encontró Chromium en ${CHROME_BIN} (variable AGENT_CHROME_BIN para cambiarlo).`);
    }
    // Puerto 0 = el sistema elige uno libre; lo leemos de stderr.
    // El servidor sale a internet por un proxy con autenticación
    // (variables https_proxy/http_proxy): se levanta un reenviador
    // local que inyecta las credenciales y Chromium lo usa directo.
    this.egressProxy = await startEgressProxy();
    const chromeArgs = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      // El proxy de salida del sandbox hace interceptación TLS con su
      // propia CA ("Hatch Sandbox Egress CA"). Este navegador usa un
      // perfil fresco sin credenciales del usuario, así que se acepta
      // como en cualquier automatización (Selenium/Puppeteer).
      '--ignore-certificate-errors',
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      'about:blank',
    ];
    if (this.egressProxy) {
      chromeArgs.push(`--proxy-server=http://127.0.0.1:${this.egressProxy.port}`);
    }
    this.proc = spawn(CHROME_BIN, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

    const wsUrl = await this._waitForDevToolsUrl();
    // Buscar la pestaña (target type=page).
    const pageTarget = await this._findPageTarget();
    this.cdp = new CdpClient(pageTarget);
    await this.cdp.connect();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    // Viewport de captura fijo.
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false,
    });
    return this;
  }

  _waitForDevToolsUrl(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('Chromium no publicó DevTools a tiempo')), timeoutMs);
      this.proc.stderr.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (m) {
          clearTimeout(timer);
          const url = new URL(m[1]);
          this.debugPort = url.port;
          resolve(m[1]);
        }
      });
      this.proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium terminó al arrancar (código ${code}): ${buf.slice(-500)}`));
      });
    });
  }

  async _findPageTarget(tries = 20) {
    const base = `http://127.0.0.1:${this.debugPort}/json/list`;
    for (let i = 0; i < tries; i++) {
      try {
        const resp = await fetch(base);
        const targets = await resp.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('No se encontró pestaña del navegador');
  }

  async navigate(url, timeoutMs = 25000) {
    let target = String(url || '').trim();
    // URLs internas del navegador (about:, data:) no llevan esquema https.
    if (!/^(https?:|about:|data:)/i.test(target)) target = 'https://' + target;
    await this.cdp.send('Page.navigate', { url: target }, timeoutMs);
    // Esperar a que cargue (con tope).
    try {
      await this._waitForLoad(timeoutMs);
    } catch {}
  }

  _waitForLoad(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const onMsg = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Page.loadEventFired') {
            clearTimeout(timer);
            this.cdp.ws.removeListener('message', onMsg);
            // Un respiro para que pinte.
            setTimeout(resolve, 800);
          }
        } catch {}
      };
      this.cdp.ws.on('message', onMsg);
    });
  }

  async screenshot() {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    return data; // base64
  }

  async info() {
    try {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: '({url: location.href, title: document.title})',
        returnByValue: true,
      });
      return result.value || { url: '', title: '' };
    } catch {
      return { url: '', title: '' };
    }
  }

  // Árbol de accesibilidad simplificado: solo elementos
  // interactivos o con nombre, con coordenadas del centro.
  async interactiveElements() {
    this.elementIndex.clear();
    let nodes = [];
    try {
      const r = await this.cdp.send('Accessibility.getFullAXTree', {});
      nodes = r.nodes || [];
    } catch {
      return [];
    }
    const INTERACTIVE = new Set([
      'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
      'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider',
      'switch', 'searchbox', 'spinbutton',
    ]);
    const out = [];
    let id = 0;
    for (const n of nodes) {
      if (n.ignored) continue;
      const role = String(n.role && n.role.value || '').toLowerCase();
      const name = String(n.name && n.name.value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      if (!INTERACTIVE.has(role)) continue;
      if (!name && role !== 'textbox' && role !== 'searchbox') continue;
      if (id >= MAX_ELEMENTS) break;
      const backendNodeId = n.backendDOMNodeId;
      if (!backendNodeId) continue;
      let x = null, y = null;
      try {
        const box = await this.cdp.send('DOM.getBoxModel', { backendNodeId }, 8000);
        const q = box.model && box.model.content;
        if (q && q.length >= 8) {
          x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
          y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
        }
      } catch {}
      if (x === null) continue;
      id += 1;
      this.elementIndex.set(id, { backendNodeId, x, y, role, name });
      out.push({ id, role, name: name || '(sin nombre)', x, y });
    }
    return out;
  }

  async observe() {
    const [shot, elements, pageInfo, pageText] = await Promise.all([
      this.screenshot(),
      this.interactiveElements(),
      this.info(),
      this.getPageText(),
    ]);
    return { screenshot: shot, elements, url: pageInfo.url, title: pageInfo.title, text: pageText };
  }

  // Texto visible de la página (para que el agente LEA precios,
  // párrafos, resultados: no todo es un elemento interactivo).
  async getPageText(maxChars = 4000) {
    try {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: `(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, ${maxChars})`,
        returnByValue: true,
      });
      return result.value || '';
    } catch {
      return '';
    }
  }

  async clickElement(id) {
    const el = this.elementIndex.get(Number(id));
    if (!el) throw new Error(`Elemento #${id} no existe en la observación actual`);
    await this.clickAt(el.x, el.y);
    return el;
  }

  async clickAt(x, y) {
    const p = { x: Number(x), y: Number(y) };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 600));
  }

  async typeText(idOrNull, text) {
    if (idOrNull !== null && idOrNull !== undefined) {
      const el = this.elementIndex.get(Number(idOrNull));
      if (!el) throw new Error(`Elemento #${idOrNull} no existe en la observación actual`);
      await this.clickAt(el.x, el.y);
      // Seleccionar contenido previo para reemplazarlo.
      await this.pressKey('a', { ctrl: true });
    }
    await this.cdp.send('Input.insertText', { text: String(text || '') });
    await new Promise((r) => setTimeout(r, 400));
  }

  async pressKey(key, { ctrl = false } = {}) {
    const KEYCODES = {
      Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
    };
    const k = KEYCODES[key] || { key, code: key, windowsVirtualKeyCode: 0 };
    const modifiers = ctrl ? 2 : 0;
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...k });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...k });
    await new Promise((r) => setTimeout(r, 400));
  }

  async scroll(dy = 600) {
    try {
      await this.cdp.send('Runtime.evaluate', { expression: `window.scrollBy(0, ${Number(dy) || 600})` });
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  async wait(ms = 1500) {
    await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 1500, 8000)));
  }

  async close() {
    try { this.cdp && this.cdp.close(); } catch {}
    try { this.egressProxy && await this.egressProxy.close(); } catch {}
    this.egressProxy = null;
    try {
      if (this.proc && !this.proc.killed) {
        this.proc.kill('SIGTERM');
        setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch {} }, 3000);
      }
    } catch {}
    this.proc = null;
    this.cdp = null;
  }
}

// Un navegador por sesión, reutilizado entre tareas.
const browsers = new Map(); // sessionId -> AgentBrowser

// ── Confirmaciones pendientes ─────────────────────────────
// El agente pide aprobación antes de acciones sensibles
// (comprar, publicar, enviar, borrar, credenciales). El frontend
// muestra el diálogo y responde vía POST /api/computer/confirm.
const pendingConfirms = new Map(); // `${sessionId}:${confirmId}` -> { resolve }

function requestConfirmation(sessionId, confirmId, timeoutMs) {
  return new Promise((resolve) => {
    const key = `${sessionId}:${confirmId}`;
    const timer = setTimeout(() => {
      pendingConfirms.delete(key);
      resolve(false); // sin respuesta = denegado
    }, timeoutMs);
    pendingConfirms.set(key, { resolve: (approved) => { clearTimeout(timer); pendingConfirms.delete(key); resolve(!!approved); } });
  });
}

function resolveConfirmation(sessionId, confirmId, approved) {
  const key = `${sessionId}:${confirmId}`;
  const pending = pendingConfirms.get(key);
  if (!pending) return false;
  pending.resolve(approved);
  return true;
}

async function getAgentBrowser(session) {
  let b = browsers.get(session.id);
  if (b && b.proc && !b.proc.killed) return b;
  if (b) { try { await b.close(); } catch {} browsers.delete(session.id); }
  b = new AgentBrowser(session.dir);
  await b.launch();
  browsers.set(session.id, b);
  return b;
}

async function closeAgentBrowser(sessionId) {
  const b = browsers.get(sessionId);
  if (b) {
    browsers.delete(sessionId);
    try { await b.close(); } catch {}
  }
}

module.exports = {
  AgentBrowser,
  getAgentBrowser,
  closeAgentBrowser,
  requestConfirmation,
  resolveConfirmation,
  VIEWPORT,
};

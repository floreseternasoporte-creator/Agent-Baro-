'use strict';
// ═══════════════════════════════════════════════════════
// mcpClient.js
// C3 (Lote 2 Claude Code): cliente MCP mínimo (JSON-RPC 2.0)
// por stdio (NDJSON, sin shell: spawn directo) y por HTTP
// (JSON o SSE). Sin OAuth en esta ronda. Cada petición tiene
// timeout y los errores son honestos y en lenguaje normal:
// si el servidor no responde, el turno lo dice y sigue con
// el resto de herramientas, nunca finge el resultado.
// ═══════════════════════════════════════════════════════

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';

class McpError extends Error {
  constructor(message, code = 'mcp_error') {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

function createStdioMcpClient({ command, args = [], env = {}, timeoutMs = 10000 }) {
  let child = null;
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  let stderrBuf = '';
  let closed = false;

  function rejectAll(err) {
    for (const [, entry] of pending) entry.reject(err);
    pending.clear();
  }

  function ensureStarted() {
    if (child || closed) return;
    child = spawn(command, args, {
      shell: false,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Las notificaciones del servidor (sin id) se ignoran.
        if (msg && typeof msg.id !== 'undefined' && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) entry.reject(new McpError(`El servidor MCP devolvió un error: ${msg.error.message || 'error desconocido'}`, 'mcp_server_error'));
          else entry.resolve(msg.result);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuf = (stderrBuf + chunk).slice(-2048);
    });
    child.on('error', (err) => {
      closed = true;
      rejectAll(new McpError(`No se pudo arrancar el servidor MCP (${command}): ${err.message}`, 'mcp_spawn_error'));
    });
    child.on('close', () => {
      closed = true;
      rejectAll(new McpError('El servidor MCP se cerró.', 'mcp_closed'));
    });
  }

  function request(method, params) {
    ensureStarted();
    if (closed) return Promise.reject(new McpError('El servidor MCP se cerró.', 'mcp_closed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new McpError(`El servidor MCP no respondió a "${method}" en ${timeoutMs / 1000} s.`, 'mcp_timeout'));
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new McpError(`No se pudo escribir al servidor MCP: ${e.message}`, 'mcp_write_error'));
      }
    });
  }

  function notify(method, params) {
    ensureStarted();
    if (closed) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // Las notificaciones no esperan respuesta: si no salen, se sigue.
    }
  }

  async function initialize() {
    const result = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'baro', version: '1.0' },
    });
    notify('notifications/initialized');
    return result;
  }

  async function listTools() {
    const result = await request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async function callTool(name, args) {
    return request('tools/call', { name, arguments: args || {} });
  }

  async function ping() {
    return request('ping', {});
  }

  function close() {
    closed = true;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Ignorar: el proceso ya no existe.
      }
    }
    child = null;
    rejectAll(new McpError('El servidor MCP se cerró.', 'mcp_closed'));
  }

  return { initialize, listTools, callTool, ping, close };
}

function createHttpMcpClient({ url, headers = {}, timeoutMs = 10000 }) {
  let nextId = 1;

  async function readSseResponse(res, id) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readLoop = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLines = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
          if (!dataLines.length) continue;
          let msg;
          try {
            msg = JSON.parse(dataLines.join('\n'));
          } catch {
            continue;
          }
          if (msg && msg.id === id) {
            if (msg.error) throw new McpError(`El servidor MCP devolvió un error: ${msg.error.message || 'error desconocido'}`, 'mcp_server_error');
            return msg.result;
          }
        }
      }
      throw new McpError('El servidor MCP cerró el canal sin responder.', 'mcp_closed');
    })();
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new McpError('El servidor MCP no respondió a tiempo por el canal de eventos.', 'mcp_timeout')), timeoutMs);
    });
    try {
      return await Promise.race([readLoop, timeout]);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignorar: el lector ya estaba cerrado.
      }
    }
  }

  async function requestJsonRpc(method, params) {
    const id = nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new McpError(`El servidor MCP no respondió a "${method}" en ${timeoutMs / 1000} s.`, 'mcp_timeout');
      }
      throw new McpError(`No se pudo conectar con el servidor MCP: ${e.message}`, 'mcp_connect_error');
    } finally {
      clearTimeout(timer);
    }
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new McpError(`El servidor MCP respondió ${res.status}: ${text.slice(0, 200) || 'sin detalle'}`, 'mcp_http_error');
    }
    if (contentType.includes('text/event-stream')) {
      return readSseResponse(res, id);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new McpError('El servidor MCP devolvió una respuesta que no es JSON.', 'mcp_bad_response');
    }
    if (data.error) {
      throw new McpError(`El servidor MCP devolvió un error: ${data.error.message || 'error desconocido'}`, 'mcp_server_error');
    }
    return data.result;
  }

  async function notifyJsonRpc(method, params) {
    // Las notificaciones no esperan respuesta: se envían y se ignora
    // cualquier fallo (muchos servidores ni las necesitan por HTTP).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: controller.signal,
      });
    } catch {
      // Ignorar.
    } finally {
      clearTimeout(timer);
    }
  }

  async function initialize() {
    const result = await requestJsonRpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'baro', version: '1.0' },
    });
    await notifyJsonRpc('notifications/initialized');
    return result;
  }

  async function listTools() {
    const result = await requestJsonRpc('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async function callTool(name, args) {
    return requestJsonRpc('tools/call', { name, arguments: args || {} });
  }

  async function ping() {
    return requestJsonRpc('ping', {});
  }

  function close() {
    // HTTP no mantiene conexión: no hay nada que cerrar.
  }

  return { initialize, listTools, callTool, ping, close };
}

/** Crea el cliente adecuado según la configuración (url o command). */
function createMcpClient(config) {
  if (!config || typeof config !== 'object') {
    throw new McpError('Falta la configuración del servidor MCP.', 'mcp_config_error');
  }
  if (typeof config.url === 'string' && config.url.trim()) {
    return createHttpMcpClient({
      url: config.url.trim(),
      headers: config.headers || {},
      timeoutMs: config.timeoutMs || 10000,
    });
  }
  if (typeof config.command === 'string' && config.command.trim()) {
    return createStdioMcpClient({
      command: config.command.trim(),
      args: config.args || [],
      env: config.env || {},
      timeoutMs: config.timeoutMs || 10000,
    });
  }
  throw new McpError('El servidor MCP necesita "url" o "command".', 'mcp_config_error');
}

/** Convierte el resultado de tools/call a texto plano para el modelo. */
function toolResultToText(result) {
  if (typeof result === 'string') return result;
  const content = result?.content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block && block.type === 'resource' && block.resource?.text) parts.push(String(block.resource.text));
      else parts.push(JSON.stringify(block));
    }
    return parts.join('\n');
  }
  return JSON.stringify(result ?? null);
}

module.exports = {
  McpError,
  PROTOCOL_VERSION,
  createStdioMcpClient,
  createHttpMcpClient,
  createMcpClient,
  toolResultToText,
};

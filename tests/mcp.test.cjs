'use strict';

// Tests C3 (Lote 2): cliente MCP mínimo (stdio y HTTP/SSE) y gestor
// de servidores (.mcp.json, descubrimiento, llamada, errores honestos).
// Servidores de juguete locales: ningún test toca internet.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMcpClient, toolResultToText, McpError } = require('../mcpClient');
const mcp = require('../mcp');

const TOY_STDIO = path.join(__dirname, 'fixtures', 'mcp-toy-stdio.cjs');

function startHttpToy(t, { sse = false } = {}) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const { id, method, params } = msg;
      if (method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      let result;
      if (method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'toy-http', version: '1.0' } };
      else if (method === 'tools/list') result = { tools: [{ name: 'echo', description: 'eco http', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
      else if (method === 'tools/call') result = { content: [{ type: 'text', text: `eco: ${params?.arguments?.text ?? ''}` }] };
      else if (method === 'ping') result = {};
      else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no conocido' } }));
        return;
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
      if (sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${payload}\n\n`);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${server.address().port}/mcp`);
    });
  });
}

test('cliente stdio: initialize, listTools y callTool contra el servidor de juguete', async (t) => {
  const client = createMcpClient({ command: 'node', args: [TOY_STDIO], timeoutMs: 5000 });
  t.after(() => client.close());
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'toy');
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
  assert.deepEqual(await client.ping(), {});
  const result = await client.callTool('echo', { text: 'hola' });
  assert.equal(toolResultToText(result), 'eco: hola');
});

test('cliente HTTP JSON: mismo flujo por POST', async (t) => {
  const url = await startHttpToy(t);
  const client = createMcpClient({ url, timeoutMs: 5000 });
  t.after(() => client.close());
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'toy-http');
  const tools = await client.listTools();
  assert.equal(tools[0].name, 'echo');
  const result = await client.callTool('echo', { text: 'http' });
  assert.equal(toolResultToText(result), 'eco: http');
});

test('cliente HTTP SSE: lee la respuesta del canal de eventos', async (t) => {
  const url = await startHttpToy(t, { sse: true });
  const client = createMcpClient({ url, timeoutMs: 5000 });
  t.after(() => client.close());
  await client.initialize();
  const tools = await client.listTools();
  assert.equal(tools[0].name, 'echo');
  const result = await client.callTool('echo', { text: 'sse' });
  assert.equal(toolResultToText(result), 'eco: sse');
});

test('cliente stdio: timeout honesto si el servidor no responde', async (t) => {
  const client = createMcpClient({
    command: 'node',
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 300,
  });
  t.after(() => client.close());
  await assert.rejects(client.initialize(), (e) => {
    assert.ok(e instanceof McpError);
    assert.equal(e.code, 'mcp_timeout');
    assert.match(e.message, /no respondió/);
    return true;
  });
});

test('cliente HTTP: error honesto si el servidor no existe', async () => {
  const client = createMcpClient({ url: 'http://127.0.0.1:1/mcp', timeoutMs: 2000 });
  await assert.rejects(client.initialize(), (e) => {
    assert.ok(e instanceof McpError);
    assert.match(e.message, /No se pudo conectar/);
    return true;
  });
});

test('createMcpClient exige url o command', () => {
  assert.throws(() => createMcpClient({}), /necesita "url" o "command"/);
  assert.throws(() => createMcpClient(null), /Falta la configuración/);
});

test('toolResultToText convierte bloques de contenido a texto', () => {
  assert.equal(toolResultToText('directo'), 'directo');
  assert.equal(toolResultToText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(toolResultToText({ content: [{ type: 'resource', resource: { text: 'recurso' } }] }), 'recurso');
  assert.equal(toolResultToText(null), 'null');
});

test('loadMcpConfig valida nombres, comandos y URLs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baro-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(mcp.loadMcpConfig(dir), null); // sin archivo
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      toy: { command: 'node', args: ['server.cjs'] },
      web: { url: 'https://ejemplo.com/mcp', headers: { Authorization: 'Bearer x' } },
    },
  }), 'utf8');
  const cfg = mcp.loadMcpConfig(dir);
  assert.deepEqual(Object.keys(cfg.servers).sort(), ['toy', 'web']);

  const bad = (servers) => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }), 'utf8');
    assert.throws(() => mcp.loadMcpConfig(dir), McpError);
  };
  bad({ 'Nombre Malo': { command: 'node' } });
  bad({ toy: { command: 'node; rm -rf /' } });
  bad({ toy: { command: 'node', url: 'https://x.com' } });
  bad({ toy: { url: 'ftp://x.com' } });
  bad({ toy: { url: 'no-es-url' } });
  bad({ toy: {} });
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{no json', 'utf8');
  assert.throws(() => mcp.loadMcpConfig(dir), /no es JSON válido/);
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ otraCosa: {} }), 'utf8');
  assert.throws(() => mcp.loadMcpConfig(dir), /mcpServers/);
});

test('sanitizeToolName produce nombres válidos y recorta a 64', () => {
  assert.equal(mcp.sanitizeToolName('mi-servidor', 'mi.tool'), 'mcp_mi-servidor_mi_tool');
  assert.equal(mcp.sanitizeToolName('s', 'a b/c').length, 'mcp_s_a_b_c'.length);
  const long = mcp.sanitizeToolName('servidor-con-nombre-muy-largo', 'herramienta-con-nombre-tambien-muy-largo');
  assert.equal(long.length, 64);
});

test('connectMcpServers descubre tools y llama; un servidor muerto no tumba al resto', async (t) => {
  const registry = await mcp.connectMcpServers({
    servers: {
      toy: { command: 'node', args: [TOY_STDIO] },
      muerto: { command: '/no/existe/este-binario' },
    },
  }, { timeoutMs: 5000 });
  t.after(() => mcp.closeMcpServers(registry));
  assert.equal(registry.definitions.length, 1);
  assert.equal(registry.definitions[0].function.name, 'mcp_toy_echo');
  assert.equal(registry.errors.length, 1);
  assert.equal(registry.errors[0].server, 'muerto');
  assert.equal(await mcp.callMcpTool(registry, 'mcp_toy_echo', { text: 'gestor' }), 'eco: gestor');
  await assert.rejects(mcp.callMcpTool(registry, 'mcp_no_existe', {}), /No hay ninguna herramienta/);
});

test('getOrConnectMcp cachea en la sesión y reconecta al expirar', async (t) => {
  const session = {};
  const config = { servers: { toy: { command: 'node', args: [TOY_STDIO] } } };
  const r1 = await mcp.getOrConnectMcp(session, config, { timeoutMs: 5000 });
  const r2 = await mcp.getOrConnectMcp(session, config, { timeoutMs: 5000 });
  assert.equal(r1, r2); // misma instancia cacheada
  session.mcp.loadedAt = Date.now() - 10 * 60 * 1000; // expirado
  const r3 = await mcp.getOrConnectMcp(session, config, { timeoutMs: 5000 });
  assert.notEqual(r3, r1);
  assert.equal(r3.definitions[0].function.name, 'mcp_toy_echo');
  await mcp.closeMcpServers(r3);
});

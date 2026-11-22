'use strict';
// Servidor MCP de juguete por stdio (NDJSON): responde initialize,
// tools/list (una tool "echo") y tools/call (devuelve "eco: <texto>").
// Solo para tests de mcpClient/mcp — no es un servidor real.

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Las notificaciones (sin id) se ignoran.
  if (!msg || typeof msg.id === 'undefined') return;
  const { id, method, params } = msg;
  const respond = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const fail = (code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  if (method === 'initialize') {
    respond({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'toy', version: '1.0' } });
  } else if (method === 'tools/list') {
    respond({
      tools: [{
        name: 'echo',
        description: 'Devuelve el texto que se le pasa',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    });
  } else if (method === 'tools/call') {
    const text = params?.arguments?.text ?? '';
    respond({ content: [{ type: 'text', text: `eco: ${text}` }] });
  } else if (method === 'ping') {
    respond({});
  } else {
    fail(-32601, `Método no conocido: ${method}`);
  }
});

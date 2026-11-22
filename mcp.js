'use strict';
// ═══════════════════════════════════════════════════════
// mcp.js
// C3 (Lote 2 Claude Code): gestor de servidores MCP de la
// sesión. Lee `.mcp.json` del workspace (nunca secretos en
// commits: el archivo vive en el workspace, no en el repo),
// valida nombres/comandos/URLs, conecta, descubre sus tools
// y las expone como tools nativas `mcp_<servidor>_<tool>`.
// Un servidor caído no tumba el turno: se registra en
// registry.errors y el turno sigue con el resto.
// La conexión se cachea en la sesión 5 minutos para no
// redescubrir en cada turno.
// ═══════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createMcpClient, toolResultToText, McpError } = require('./mcpClient');

const MCP_CONFIG_FILE = '.mcp.json';
const MCP_CACHE_TTL_MS = 5 * 60 * 1000;
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const FORBIDDEN_COMMAND_CHARS = /[;&|$`()<>\n\r]/;

function validateServerConfig(name, server) {
  if (!NAME_RE.test(name)) {
    throw new McpError(`Nombre de servidor MCP no válido: "${name}" (solo minúsculas, números y guiones).`, 'mcp_config_error');
  }
  if (!server || typeof server !== 'object' || Array.isArray(server)) {
    throw new McpError(`El servidor MCP "${name}" necesita un objeto con "command" o "url".`, 'mcp_config_error');
  }
  const hasCommand = typeof server.command === 'string' && server.command.trim();
  const hasUrl = typeof server.url === 'string' && server.url.trim();
  if (!hasCommand && !hasUrl) {
    throw new McpError(`El servidor MCP "${name}" necesita "command" o "url".`, 'mcp_config_error');
  }
  if (hasCommand && hasUrl) {
    throw new McpError(`El servidor MCP "${name}" no puede tener "command" y "url" a la vez.`, 'mcp_config_error');
  }
  if (hasCommand) {
    if (FORBIDDEN_COMMAND_CHARS.test(server.command)) {
      throw new McpError(`El comando del servidor MCP "${name}" tiene caracteres no permitidos.`, 'mcp_config_error');
    }
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string'))) {
      throw new McpError(`Los argumentos del servidor MCP "${name}" deben ser una lista de textos.`, 'mcp_config_error');
    }
    if (server.env !== undefined && (typeof server.env !== 'object' || Array.isArray(server.env) || Object.values(server.env).some((v) => typeof v !== 'string'))) {
      throw new McpError(`Las variables del servidor MCP "${name}" deben ser textos.`, 'mcp_config_error');
    }
  }
  if (hasUrl) {
    let parsed;
    try {
      parsed = new URL(server.url.trim());
    } catch {
      throw new McpError(`La URL del servidor MCP "${name}" no es válida.`, 'mcp_config_error');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new McpError(`La URL del servidor MCP "${name}" debe ser http o https.`, 'mcp_config_error');
    }
    if (server.headers !== undefined && (typeof server.headers !== 'object' || Array.isArray(server.headers) || Object.values(server.headers).some((v) => typeof v !== 'string'))) {
      throw new McpError(`Los encabezados del servidor MCP "${name}" deben ser textos.`, 'mcp_config_error');
    }
  }
  return server;
}

/** Lee y valida `.mcp.json` del workspace; null si no existe. */
function loadMcpConfig(dir) {
  const file = path.join(dir, MCP_CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new McpError(`El archivo .mcp.json no es JSON válido: ${e.message}`, 'mcp_config_error');
  }
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new McpError('El archivo .mcp.json necesita un objeto "mcpServers".', 'mcp_config_error');
  }
  const out = {};
  for (const [name, server] of Object.entries(servers)) {
    out[name] = validateServerConfig(name, server);
  }
  return { servers: out };
}

/** "mcp_<servidor>_<tool>" con caracteres válidos para function calling (máx. 64). */
function sanitizeToolName(serverName, toolName) {
  const clean = `mcp_${serverName}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return clean.slice(0, 64);
}

/**
 * Conecta todos los servidores de la configuración y descubre sus
 * tools. Devuelve { clients, tools, definitions, errors }.
 * Un servidor que falla no tumba a los demás.
 */
async function connectMcpServers(config, { timeoutMs = 10000 } = {}) {
  const registry = { clients: new Map(), tools: new Map(), definitions: [], errors: [] };
  if (!config || !config.servers) return registry;
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    let client = null;
    try {
      client = createMcpClient({ ...serverConfig, timeoutMs });
      await client.initialize();
      const tools = await client.listTools();
      registry.clients.set(serverName, client);
      for (const tool of tools) {
        const defName = sanitizeToolName(serverName, tool.name);
        if (registry.tools.has(defName)) continue; // colisión: gana el primero
        registry.tools.set(defName, { server: serverName, name: tool.name });
        registry.definitions.push({
          type: 'function',
          function: {
            name: defName,
            description: tool.description || `Herramienta ${tool.name} del servidor ${serverName}.`,
            parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
              ? tool.inputSchema
              : { type: 'object', properties: {} },
          },
        });
      }
    } catch (e) {
      registry.errors.push({ server: serverName, message: e.message });
      try {
        client?.close();
      } catch {
        // Ignorar: el cliente ya estaba cerrado.
      }
    }
  }
  return registry;
}

/** Llama a una tool MCP por su nombre `mcp_<servidor>_<tool>`; devuelve texto plano. */
async function callMcpTool(registry, defName, args) {
  const entry = registry?.tools?.get(defName);
  if (!entry) throw new McpError('No hay ninguna herramienta conectada con ese nombre.', 'mcp_unknown_tool');
  const client = registry.clients.get(entry.server);
  if (!client) throw new McpError('El servidor de esa herramienta no está conectado.', 'mcp_not_connected');
  const result = await client.callTool(entry.name, args || {});
  return toolResultToText(result);
}

async function closeMcpServers(registry) {
  if (!registry) return;
  for (const client of registry.clients.values()) {
    try {
      client.close();
    } catch {
      // Ignorar: el cliente ya estaba cerrado.
    }
  }
  registry.clients.clear();
}

/** Conexión cacheada en la sesión (5 min): no redescubrir en cada turno. */
async function getOrConnectMcp(session, config, opts) {
  const cached = session.mcp;
  if (cached && cached.registry && Date.now() - cached.loadedAt < MCP_CACHE_TTL_MS) {
    return cached.registry;
  }
  if (cached?.registry) await closeMcpServers(cached.registry);
  const registry = await connectMcpServers(config, opts);
  session.mcp = { registry, loadedAt: Date.now() };
  return registry;
}

module.exports = {
  MCP_CONFIG_FILE,
  loadMcpConfig,
  sanitizeToolName,
  connectMcpServers,
  callMcpTool,
  closeMcpServers,
  getOrConnectMcp,
};

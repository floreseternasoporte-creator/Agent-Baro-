# AGENTS.md — Agent-Baro

Instrucciones para cualquier agente (Baro incluido) que trabaje en este repo.

## Qué es esto

Baro es un agente autónomo de código e investigación: backend Node/Express
plano (sin subcarpetas de código) + frontend vanilla (HTML/CSS/JS sin build).
Clona repos reales, lee/escribe archivos, aplica diffs, ejecuta comandos con
lista blanca, verifica con tests y hace push a GitHub.

## Organización

- `server.js` — entry point Express: sirve el frontend y monta `/api/*`.
- `chatRoutes.js` — el turno de chat (SSE): failover de proveedores, rondas
  automáticas (12), auto-review de diffs, verificación con tests, eventos
  `plan` / `verify` / `log` / `computer` / `delta` / `done`.
- `groqClient.js` — cliente Groq + el system prompt compartido del agente.
- `pollinationsClient.js` / `ollamaClient.js` — proveedores de respaldo.
- `toolsClient.js` + `toolCommands.js` + `toolsRoutes.js` — búsqueda (Tavily),
  Wikipedia, video (Seedance), imágenes, documentos (Document Studio).
- `gitAgent.js` — disco y git reales: clonado, diffs seguros, commit + push,
  checkpoints para Deshacer.
- `commandRunner.js` — ejecución de comandos con lista blanca (sin shell).
- `sessionStore.js` / `memoryStore.js` — sesiones, workspaces y memoria.
- `computerUse.js` / `computerTask.js` / `visionClient.js` — modo computadora
  (Chromium real con visión local).
- `index.html` / `script.js` / `app-shell.js` / `style.css` — frontend. Diseño Apple/iMessage
  cristalino (ver `style.css`: cristal con blur, azul #007AFF, modo oscuro iOS).
  **v7 App shell:** sidebar persistente + drawer móvil, columna central de
  860px, inspector lateral (Plan/Actividad/Vista de computadora, solo visible
  mientras el agente trabaja), paleta de comandos (Ctrl/⌘+K), atajos
  (Ctrl/⌘+B sidebar) y PWA (`manifest.webmanifest` + `icon.svg`, servidos por
  la whitelist de `server.js`). Sin service worker a propósito: un SW con
  caché del shell dejaría el frontend rancio tras cada push.
  **v7.1:** iconos SÓLIDOS en todo el chrome (sidebar, topbar, bottomnav,
  tarjetas, paleta) — los outline finos estilo Feather quedaron fuera;
  marca nueva = squircle azul con B (`#baro-mark`, un solo `<symbol>` en
  `index.html`, favicon e `icon.svg` iguales); sidebar sólida y compacta
  (`--sidebar-bg`) con contenido blanco en escritorio; barra de estado al
  pie (repo/modelo/contexto/conexión, `syncStatusBar()` + observer del
  punto de conexión); inicio compacto (hero pequeño, acciones como lista
  densa en escritorio). Ctrl/⌘+K era Nuevo chat en v6: ahora es la paleta
  y Nuevo chat es Ctrl/⌘+Mayús+K.
  **v8 (shell estilo app iOS, refs Grok — solo lenguaje visual, no su
  marca ni sus textos):** fondo negro puro, tarjetas agrupadas #1C1C1E
  radio 20-24px, hairlines `--hair-soft`, botones circulares #2C2C2E.
  Pantalla `chats` (inicio en móvil ≤768px: avatar + nuevo chat, fila
  Baro con preview/hora vía `renderChatsList()`, abajo cuadrícula →
  Tareas + píldora Buscar → `openPalette()`); en móvil desaparecen
  sidebar/topbar/statusbar/bottomnav y manda el shell Grok
  (`#chat-mheader`: atrás ‹ → lista, píldora Baro, … → ajustes).
  Burbujas: Baro = azul #0A84FF texto blanco, usuario =
  `--bubble-user` (#1C1C1E claro, #2C2C2E oscuro — en escritorio
  oscuro el fondo es #1C1C1E y el #1C1C1E no se veía); composer en
  píldora con + (paleta) y micrófono que NO graba (`voiceUnavailable()`,
  Baro sigue siendo solo texto por diseño); `mkStream()` pinta estado
  "Generando…" con logo Baro y `finalStream()` lo retira. Ajustes con
  sección Cuenta (avatar con iniciales + nombre de Firebase,
  `syncUserAvatar()`) y etiqueta Bot; solo opciones reales de Baro.
  Trampa v8: el chat arranca oculto en móvil, así que `autoGrow()` con
  scrollHeight 0 dejaba el textarea en 0px — ahora guarda la altura y
  `showScreen('chat')` llama a `autoGrow()` al entrar.
  **v9 (lote Codex H1+H3+H6, serie de commits locales v9):**
  **H1 function calling nativo:** catálogo en `toolsCatalog.js` (14 tools
  OpenAI-compatibles) + `streamChatWithTools()` en los 3 clientes
  (Groq nativo; Pollinations/Ollama degradan a texto de forma explícita
  si el proveedor rechaza `tools`). El turno (`chatRoutes.js`) despacha
  los `tool_calls` por la MISMA vía que el texto (mismo plan-mode,
  misma deduplicación, mismo auto-review de diffs vía `processDiffBlock`);
  el texto ("Buscar:", "Ejecuta:", ```diff) sigue como respaldo.
  `create_script` nativo pasa el código en el argumento `code`.
  **H3 ramas + PRs:** el agente JAMÁS escribe sobre `main`/`master`
  directo: antes del primer diff del turno, `ensureTaskBranch` crea
  `baro/<slug>-<ts>` (`gitAgent.js: createTaskBranch`, publica la ref
  si hay token) y `session.taskBranch/baseBranch` la recuerdan; el push
  sube la rama de tarea y `POST /api/agent/pr` abre el PR contra
  api.github.com (sin token responde `no-token` honesto, nunca finge
  el PR; si ya existe uno abierto para la rama, lo devuelve). Botón
  "Abrir PR" en el modal de push (`script.js: openPullRequest()`).
  **H6 entorno reproducible:** `envSetup.js` detecta setup + tests del
  repo (manifiestos o secciones `## Setup` / `## Testing` de su
  AGENTS.md, que mandan) y los ejecuta UNA vez por sesión al conectar
  (`repoRoutes.js`, en segundo plano; `POST /api/agent/env-setup` y
  `GET /api/agent/env-health`); el resultado queda en
  `session.envHealth` y el turno lo anuncia en el log antes de
  escribir código. `agentsMd.js: buildAgentsMdSkeleton` ya genera
  esas secciones. Setup con timeout 10 min, siempre por la lista
  blanca de `commandRunner.js`.
  **v11 (Lote 2 Claude Code, serie de commits locales v11):**
  **C17 herramientas nativas de archivo:** `fileTools.js` (leer por
  líneas, buscar por patrón, listar por glob, diff de reemplazo
  exacto con texto único) + 4 tools en el catálogo (`read_file`,
  `search_files`, `list_files`, `edit_file`, 19 en total) con sus
  líneas de texto (`Leer archivo:`, `Buscar en archivos:`, `Listar
  archivos:`, `Editar archivo:`). `edit_file` devuelve kind `edit`
  y pasa por la misma revisión que `apply_diff` (`applyEditDiff` en
  `chatRoutes.js`: plan-mode, proyecto, autoApply, rama de tarea,
  auto-review). Lectura/búsqueda/listado son de solo lectura en
  modo plan.
  **C1 subagentes reales:** `subagent.js` — `runSubagent` con contexto
  propio por kind (explore/review/general), 6 rondas y timeout de
  120 s; allowlist de solo lectura (las 3 de archivo + `search_web`
  y `lookup_wikipedia`): cualquier intento de escribir se le niega.
  Tool nativa `delegate_task` + línea `Delegar:` (de solo lectura
  en modo plan). Corre dentro del turno principal: sobrevive a la
  desconexión (H2) y se cancela con él (el abort del padre se
  propaga; el timeout y los fallos del proveedor son un resultado
  honesto, no una muerte del turno). El generador se inyecta
  (`streamToolsFn`) para no crear un require circular.
  **C2 skills:** `skills.js` + `.baro/skills/<nombre>/SKILL.md`
  (frontmatter: name, description, when, label, defaultTask).
  Fuentes en orden de prioridad: `.baro/skills/` del repo,
  `~/.baro/skills/` del usuario, `.baro/skills/` del proyecto.
  Integradas: revisar, verificar, documentar. El turno inyecta
  las descripciones en el prompt siempre y el cuerpo completo solo
  de la activa: por invocación `/nombre` (con tarea por defecto si
  viene solo) o por relevancia con el mensaje (umbral 3, máx. 2).
  **C3 MCP:** `mcpClient.js` (JSON-RPC 2.0 por stdio NDJSON sin
  shell y por HTTP JSON/SSE, sin OAuth, timeout por petición) +
  `mcp.js` (lee y valida `.mcp.json` del workspace — ver
  `.mcp.json.example`—, descubre tools y las expone como nativas
  `mcp_<servidor>_<tool>`; un servidor caído no tumba el turno;
  caché en la sesión 5 min). Despacho antes del traductor nativo,
  bloqueado en modo plan; la cabecera visible usa el nombre
  original de la herramienta, nunca el prefijo `mcp_`.
  **REGLA DE UI (Lote 2):** nada de esto asoma en la vista del
  usuario con nombres internos (subagente, skill, MCP, tool,
  Read/Grep/Glob/Edit, proveedor/modelo, tokens, contexto): logs
  y textos visibles solo en lenguaje normal.
- **Firebase (validación de sesiones):** toda la API exige un token
  Firebase válido (`authMiddleware.js` + `firebaseTokenVerifier.js`,
  que verifica la firma RS256 contra las claves públicas de Google
  sin depender de `firebase-admin`). Variable obligatoria en el
  despliegue (Railway): `FIREBASE_PROJECT_ID=ggggg-f2508`. Sin ella
  TODA la API devuelve 503 con código `firebase_project_not_configured`
  y el mensaje dice qué poner; si Google no responde, el 503 es
  `firebase_keys_unreachable` (reintenta el fetch de claves una vez).
  El servidor avisa al arrancar si falta la variable y
  `/api/health` lo expone como `firebaseAuth: ready|not_configured`.
  El chat muestra el mensaje del servidor tal cual (`**Error:** …`).
- `workspaces/` — clones por sesión. Nunca se versiona.

## Comandos

```bash
npm install     # dependencias
npm start       # arranca el servidor (PORT o 3000)
npm test        # suite nativa de Node, sin dependencias adicionales
node --check <archivo>.js   # validación de sintaxis obligatoria tras editar
```

Ejecuta `npm test` y `node --check` para los `.js` tocados; para cambios de
comportamiento, levanta el servidor y prueba el flujo real (sesión → chat →
diff → tests).

## Convenciones

- **CommonJS** (`require` / `module.exports`), Node ≥ 18, sin TypeScript ni
  build. En el shell, usar contratos JSDoc con `// @ts-check`.
- **Sin dependencias nuevas sin permiso expreso.** Todo lo que hace falta
  ya está en `package.json` o en la stdlib de Node.
- **Stack 100% gratuito:** Groq → Pollinations → Ollama. Nada de proveedores
  de pago en el camino del chat (el video de BytePlus es la única excepción
  y es opcional).
- **Nunca secretos en el repo:** claves solo por variables de entorno
  (ver `.env.example`). Nada de tokens en código, logs ni commits.
- **Seguridad ante todo:** comandos solo de la lista blanca de
  `commandRunner.js`, nunca `shell: true` ni concatenar strings a un shell;
  rutas siempre resueltas dentro del workspace de la sesión.
- **Frontend sin frameworks:** vanilla JS/CSS, sin librerías nuevas.
  El chat es **solo texto**: no reintroducir funciones de audio
  (dictado, TTS ni modo voz) — se eliminaron a propósito en v6.
- **Diseño:** mantener la identidad Apple/iMessage (cristal, #007AFF,
  burbujas con radio 20px, hairlines). Iconos SVG propios con
  `viewBox="0 0 24 24"`, trazo 1.8 y contenedores cuadrados centrados;
  nada de imágenes de logo externas.
- Los diffs se aplican con la librería `diff` sobre el contenido real del
  archivo; un diff que no calza se rechaza con motivo, nunca se fuerza.
- El push a GitHub es siempre acción explícita del usuario.

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
- `index.html` / `script.js` / `app-shell.js` / `style.css` — frontend vanilla
  responsive: tabs móviles, sidebar de escritorio y estilo Apple/iMessage.
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

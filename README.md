# DevAgent

Agente de codigo con capacidades reales: clona repos de verdad, lee y escribe archivos reales, ejecuta comandos reales (`npm`, `pytest`, etc.) y hace commit + push real a GitHub — todo desde una interfaz movil.

## Arquitectura

Todo el proyecto es plano — sin subcarpetas de codigo, para poder subirlo directo a un repo de GitHub sin reorganizar nada:

```
index.html         → Frontend: markup (movil-first, estilo Claude)
script.js           → Frontend: toda la logica de UI + llamadas a /api/*
style.css           → Frontend: estilos

server.js           → Backend: entry point, sirve el frontend + monta la API (esto arranca "npm start")
sessionStore.js      → Backend: sesiones/workspaces en memoria + disco
gitAgent.js          → Backend: clonado, lectura/escritura, aplicacion de diffs, commit+push
commandRunner.js     → Backend: ejecucion de comandos reales con lista blanca de seguridad
groqClient.js        → Backend: cliente de Groq (streaming SSE) con el prompt del agente
repoRoutes.js        → Backend: conectar repo, listar/leer archivos
chatRoutes.js        → Backend: chat con streaming, enriquecido con archivos reales
agentRoutes.js       → Backend: aplicar diffs, ejecutar comandos, push

workspaces/          → Clones reales de repos (uno por sesion, no se versiona — ver .gitignore)
```

El servidor filtra explicitamente que solo `index.html`, `script.js`, `style.css` y assets de imagen/fuente se sirvan como archivos publicos — el resto de los `.js` (el codigo del backend) nunca se expone via GET aunque vivan en la misma carpeta.

El frontend nunca habla directo con Groq o GitHub — todo pasa por `/api/*`, que es quien realmente clona, lee, escribe y ejecuta contra un contenedor Linux real (el mismo principio que usan Codex, Claude Code o Copilot Agent, a menor escala).

## Desarrollo local

```bash
npm install
cp .env.example .env   # opcional: pon ahi tu GROQ_API_KEY/GITHUB_TOKEN si no quieres pegarlos en la app
npm start
```

Abre `http://localhost:3000`.

## Desplegar en Railway

1. Sube este proyecto (el contenido de esta carpeta) a un repositorio de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**, elige ese repositorio.
3. Railway detecta `package.json` y usa Nixpacks automaticamente (confirmado por `railway.json`: build con `npm install`, arranque con `npm start`).
4. En **Variables**, agrega (todas opcionales, pero recomendadas para no pedirle claves a cada usuario):
   - `GROQ_API_KEY` — tu clave gratuita de [console.groq.com/keys](https://console.groq.com/keys)
   - `GITHUB_TOKEN` — un Personal Access Token con permiso `repo` (Settings → Developer settings → Personal access tokens en GitHub)
   - `AGENT_GIT_NAME` / `AGENT_GIT_EMAIL` — nombre/email que apareceran en los commits que haga el agente
5. Railway asigna la variable `PORT` automaticamente; el servidor ya la lee (`process.env.PORT`), no hay que tocarla.
6. Deploy. El healthcheck vive en `/api/health` y Railway lo usa para saber cuando el servicio esta listo.

Si prefieres no poner las claves como variables de entorno del servidor, cualquier usuario puede pegarlas en **Configuracion** dentro de la app; quedan solo en su navegador (`localStorage`), nunca en el servidor.

## Seguridad

- Los comandos que el agente puede ejecutar estan en una lista blanca explicita (`commandRunner.js`): `npm`, `npx`, `node`, `python`/`python3`, `pip`, `pytest`, `yarn`, y subcomandos de solo lectura de `git`. Cualquier otro binario se rechaza.
- Cada sesion tiene su propia carpeta de workspace; dos personas usando la misma instancia nunca comparten archivos.
- Las sesiones inactivas por mas de 6 horas se limpian solas (memoria y disco).
- El backend nunca ejecuta comandos con `shell: true` ni concatena strings a un shell — todo va como arrays de argumentos a `execFile`, evitando inyeccion de comandos.

# DevAgent

Agente de codigo con capacidades reales: clona repos de verdad, lee y escribe archivos reales, ejecuta comandos reales (`npm`, `python`, `pytest`, etc.), verifica los cambios automáticamente y hace commit + push real a GitHub — todo desde una interfaz movil.

Ademas de codigo, el agente tiene herramientas generales tipo Perplexity:
- **Busqueda web en tiempo real** (Tavily) — el chat muestra en vivo que pagina esta visitando.
- **Wikipedia** — datos enciclopedicos directos, sin clave necesaria.
- **Generacion de video con IA** (Seedance/ByteDance) — hasta 10 minutos por video (encadenando clips), maximo 10 videos por dia.
- **Edicion y animacion de imagenes con IA** — describe el cambio y el agente lo genera, incluyendo lotes de varias fotos.

Ver la sección [Herramientas nuevas](#herramientas-nuevas-busqueda-wikipedia-video-e-imagenes) para configuracion y limites.

## Arquitectura

Todo el proyecto es plano — sin subcarpetas de codigo, para poder subirlo directo a un repo de GitHub sin reorganizar nada:

```
index.html         → Frontend: markup (movil-first, estilo Claude)
script.js           → Frontend: toda la logica de UI + llamadas a /api/*
style.css           → Frontend: estilos

server.js           → Backend: entry point, sirve el frontend + monta la API (esto arranca "npm start")
sessionStore.js      → Backend: sesiones/workspaces en memoria + disco
gitAgent.js          → Backend: clonado, lectura/escritura, aplicacion segura de diffs, commit+push
commandRunner.js     → Backend: ejecucion automatica de comandos reales con lista blanca de seguridad
groqClient.js        → Backend: cliente de Groq (streaming SSE) con el prompt del agente
repoRoutes.js        → Backend: conectar repo, listar/leer archivos
chatRoutes.js        → Backend: chat con streaming, enriquecido con archivos reales
agentRoutes.js       → Backend: aplicar diffs, ejecutar comandos, push
toolsClient.js        → Backend: busqueda web (Tavily), Wikipedia, video (Seedance), edicion de imagenes
toolsRoutes.js        → Backend: endpoints /api/tools/* en streaming (SSE) para cada herramienta
toolCommands.js        → Backend: detecta "Buscar:", "Wikipedia:", "Generar video:", "Editar imagen:" en las respuestas de la IA

workspaces/          → Clones reales de repos (uno por sesion, no se versiona — ver .gitignore)
```

El servidor filtra explicitamente que solo `index.html`, `script.js`, `style.css` y assets de imagen/fuente se sirvan como archivos publicos — el resto de los `.js` (el codigo del backend) nunca se expone via GET aunque vivan en la misma carpeta.

Al conectar un repositorio, el agente crea un perfil estructural leyendo manifiestos, documentación, puntos de entrada y archivos de pruebas. Los diffs seguros se aplican y se verifican automáticamente dentro del workspace; el push a GitHub sigue siendo una acción explícita del usuario.

El frontend nunca habla directo con Groq o GitHub — todo pasa por `/api/*`, que es quien realmente clona, lee, escribe y ejecuta contra un contenedor Linux real (el mismo principio que usan Codex, Claude Code o Copilot Agent, a menor escala).

## Desarrollo local

```bash
npm install
cp .env.example .env   # opcional: pon ahi tu GROQ_API_KEY/GITHUB_TOKEN si no quieres pegarlos en la app
npm start
```

Abre `http://localhost:3000`.

El agente puede ejecutar proyectos JavaScript y Python. En Replit se incluye Python 3.11 para permitir `python`, `python3`, `pytest` y validaciones como `python -m compileall`. Los comandos siguen ejecutándose sin `shell: true`, dentro del workspace aislado y con límites de tiempo y salida.

## Desplegar en Railway

1. Sube este proyecto (el contenido de esta carpeta) a un repositorio de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo**, elige ese repositorio.
3. Railway detecta `package.json` y usa Nixpacks automaticamente (confirmado por `railway.json`: build con `npm install`, arranque con `npm start`).
4. En **Variables**, agrega (todas opcionales, pero recomendadas para no pedirle claves a cada usuario):
   - `GROQ_API_KEY` — tu clave gratuita de [console.groq.com/keys](https://console.groq.com/keys)
   - `GITHUB_TOKEN` — un Personal Access Token con permiso `repo` (Settings → Developer settings → Personal access tokens en GitHub)
   - `AGENT_GIT_NAME` / `AGENT_GIT_EMAIL` — nombre/email que apareceran en los commits que haga el agente
   - `TAVILY_API_KEY` — clave gratuita de [tavily.com](https://tavily.com) para busqueda web en tiempo real
   - `OPENROUTER_API_KEY` — necesaria para edicion de imagenes con IA (y sirve como fallback del chat)
   - `BYTEPLUS_API_KEY` — clave de pago de BytePlus ModelArk para generar video con Seedance (opcional; sin ella, el agente sigue funcionando normalmente pero sin generar video)
5. Railway asigna la variable `PORT` automaticamente; el servidor ya la lee (`process.env.PORT`), no hay que tocarla.
6. Deploy. El healthcheck vive en `/api/health` y Railway lo usa para saber cuando el servicio esta listo.

Si prefieres no poner las claves como variables de entorno del servidor, cualquier usuario puede pegarlas en **Configuracion** dentro de la app; quedan solo en su navegador (`localStorage`), nunca en el servidor.

## Herramientas nuevas: busqueda, Wikipedia, video e imagenes

Estas herramientas funcionan de dos maneras:
1. **Dentro del chat**, la propia IA decide usarlas cuando hacen falta (por ejemplo, si preguntas algo sobre noticias actuales, escribe `Buscar: ...` en su respuesta y el backend ejecuta la busqueda real, mostrando en vivo cada pagina visitada en el log de la conversacion).
2. **Como endpoints directos** en streaming (SSE) bajo `/api/tools/*`, por si el frontend quiere una UI dedicada (por ejemplo un boton "Investigar" o un editor de fotos separado del chat).

### Busqueda web en tiempo real — Tavily
- Gratis: **1000 busquedas al mes, sin tarjeta de credito**. Se creo especificamente para agentes de IA (a diferencia de Google/Bing, ya devuelve el contenido extraido y limpio de cada pagina, no solo el enlace).
- Consigue tu clave en [tavily.com](https://tavily.com) y ponla en `TAVILY_API_KEY`.
- Endpoint: `POST /api/tools/search` `{ query, topic }` → eventos `step` (`search_start`, `search_visit`, `search_done`) y `done` con `{ answer, results }`.

### Wikipedia
- API publica oficial de Wikimedia, **gratis y sin clave**. Busca el articulo mas relevante y devuelve su resumen real.
- Endpoint: `POST /api/tools/wikipedia` `{ query, lang }` (lang por defecto `es`).

### Generacion de video con IA — Seedance (ByteDance / BytePlus)
- **Es un servicio de pago por segundo generado.** No existe, a la fecha, ningun proveedor serio con tier gratuito real de video con IA en produccion — se paga con tu propia clave de BytePlus/Volcengine ModelArk.
- Limite tecnico real del modelo: **15 segundos por generacion individual** (Seedance 2.0) o 30s (Seedance 2.5). Para pedidos mas largos, el backend **encadena automaticamente clips** usando el ultimo frame de cada clip como referencia del siguiente, hasta el tope que pediste de **10 minutos (600s) por video**.
- Limite de uso: **maximo 10 videos generados por dia** en toda la instancia (contador en memoria del servidor, ver `MAX_VIDEOS_PER_DAY` en `toolsClient.js`; para multiples usuarios reales conviene mover ese contador a una base de datos compartida).
- Consigue tu clave en BytePlus ModelArk y ponla en `BYTEPLUS_API_KEY`.
- Endpoint: `POST /api/tools/video` `{ prompt, durationSec, referenceImageUrl }` → eventos `step` por cada clip (`video_clip_start`, `video_clip_progress`, `video_clip_ready`) y `done` con la lista de clips generados.
- `GET /api/tools/video/usage` devuelve cuantos videos quedan disponibles hoy.

### Edicion y animacion de imagenes con IA
- Usa un modelo con soporte de imagenes via OpenRouter (misma `OPENROUTER_API_KEY` que ya usa el chat). Sirve para "edita esta foto", "quitale el fondo", "animala", etc. Para animar una imagen (convertirla en video), el resultado se puede pasar como `referenceImageUrl` a la generacion de video.
- Soporta lotes: si le pasas una lista de fotos con la misma instruccion, las procesa una por una y reporta el progreso en vivo.
- Endpoint: `POST /api/tools/image-edit` `{ imageUrl, instruction }` o `{ images: [...], instruction }` para lotes.

## Seguridad

- Los comandos que el agente puede ejecutar estan en una lista blanca explicita (`commandRunner.js`): `npm`, `npx`, `node`, `python`/`python3`, `pip`, `pytest`, `yarn`, y subcomandos de solo lectura de `git`. Cualquier otro binario se rechaza.
- Cada sesion tiene su propia carpeta de workspace; dos personas usando la misma instancia nunca comparten archivos.
- Las sesiones inactivas por mas de 6 horas se limpian solas (memoria y disco).
- El backend nunca ejecuta comandos con `shell: true` ni concatena strings a un shell — todo va como arrays de argumentos a `execFile`, evitando inyeccion de comandos.

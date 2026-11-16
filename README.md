# Baro

Agente autónomo de código e investigación de nivel élite: clona repos de verdad, lee y escribe archivos reales, ejecuta comandos reales (`npm`, `python`, `pytest`, etc.), verifica los cambios automáticamente y hace commit + push real a GitHub — todo desde una interfaz móvil con diseño Apple/iMessage cristalino. El chat es solo texto: sin funciones de audio. Piensa y trabaja con arquitectura estilo Astra: auto-revisión de cada cambio antes de aplicarlo, verificación automática con tests reales, memoria duradera de sesión que sobrevive a los resúmenes, herramientas en paralelo y hasta 12 rondas automáticas por turno.

Stack **100% gratuito**: Groq (Llama 3.3 70B, gratis con key) → Pollinations (gratis, sin clave, siempre disponible) → Ollama local. Sin OpenRouter, sin pagos, sin tarjetas. Ver [Proveedores](#proveedores-100-gratuitos).

Además de código, el agente tiene herramientas generales tipo Perplexity:
- **Investigación profunda** — análisis a fondo estilo Deep Research: 4–6 búsquedas desde ángulos distintos, lectura de fuentes reales e informe estructurado con citas (ver abajo).
- **Búsqueda web en tiempo real** (Tavily) — el chat muestra en vivo qué página está visitando.
- **Wikipedia** — datos enciclopédicos directos, sin clave necesaria.
- **Generación de video con IA** (Seedance/ByteDance) — hasta 10 minutos por video (encadenando clips), máximo 10 videos por día.
- **Edición y animación de imágenes con IA** — describe el cambio y el agente lo genera, incluyendo lotes de varias fotos.

Ver la sección [Herramientas nuevas](#herramientas-nuevas-busqueda-wikipedia-video-e-imagenes) para configuración y límites.

## Novedades v6 «Codex»

Baro adopta el flujo de trabajo de los agentes de código modernos (estilo Codex):

- **`AGENTS.md` del repo conectado**: al conectar un repositorio, Baro lee su `AGENTS.md` (y el de los subdirectorios) y lo respeta como instrucciones del proyecto. Desde Tareas → «Crear AGENTS.md» (o `POST /api/agent/init`) genera uno inicial analizando el repo.
- **Plan visible**: cada turno emite su plan paso a paso (evento SSE `plan`) y la app lo muestra como checklist viva sobre el composer: pendiente → en curso → hecho.
- **Verificación visible**: tras aplicar cambios se ejecutan los tests del proyecto (evento `verify`) y el resultado queda como chip permanente en el turno: ✅ superados o ❌ con fallos, con el runner usado.
- **Checkpoint y Deshacer**: antes de tocar el workspace se crea un checkpoint; el botón «Deshacer» (`POST /api/agent/undo`) vuelve a él. «Ver diff» (`GET /api/agent/diff`) muestra archivos cambiados y el diff completo en un modal.
- **Revisión de código**: modo de revisión dedicado que analiza el diff/código sin editar y reporta hallazgos accionables.
- **Modo Auto / Preguntar**: control segmentado en el composer. En «Preguntar» ningún diff se aplica solo: cada bloque queda con su botón Aplicar/Descartar.
- **La evidencia no desaparece**: al terminar un turno, el log de actividad y la vista de computadora quedan colapsados pero consultables, no se borran.
- **Conversación persistente**: el chat se guarda en el navegador y se restaura al volver. Si un repo se reconecta solo, la app pregunta antes de analizarlo (ya no dispara análisis autónomos sin avisar).
- **Diseño Apple / iMessage cristalino**: superficies de cristal (`backdrop-filter: blur(20px) saturate(180%)`), azul sistema `#007AFF`, burbujas estilo iMessage (azul con degradado para ti, gris cristalino para Baro), tipografía del sistema, modo oscuro iOS según `prefers-color-scheme` e iconos SVG propios uniformes (24px, trazo 1.8). El logo ya no depende de ninguna imagen externa.
- **Sin función de audio**: se eliminaron el dictado por voz, la lectura en voz alta (TTS) y el modo conversación por voz. El chat es solo texto; el frontend ya no usa la capacidad `voiceMode`.

## Arquitectura

Todo el proyecto es plano — sin subcarpetas de codigo, para poder subirlo directo a un repo de GitHub sin reorganizar nada:

```
index.html         → Frontend: markup responsive (tabs móviles y sidebar en escritorio)
script.js           → Frontend: chat, tareas, archivos y llamadas a /api/*
app-shell.js        → Frontend: acción de nueva conversación, JSDoc con @ts-check
style.css           → Frontend: workspace cristalino, azul #007AFF y modo oscuro
AGENTS.md           → Instrucciones de este repo para agentes (Baro lo lee al conectar)
.env.example        → Plantilla de variables de entorno (todas opcionales)

server.js           → Backend: entry point, sirve el frontend + monta la API (esto arranca "npm start")
sessionStore.js      → Backend: sesiones/workspaces en memoria + disco
gitAgent.js          → Backend: clonado, lectura/escritura, aplicacion segura de diffs, commit+push
commandRunner.js     → Backend: ejecucion automatica de comandos reales con lista blanca de seguridad
groqClient.js        → Backend: cliente de Groq (streaming SSE) con el prompt del agente Baro
repoRoutes.js        → Backend: conectar repo, listar/leer archivos
chatRoutes.js        → Backend: chat con streaming, enriquecido con archivos reales
agentRoutes.js       → Backend: aplicar diffs, ejecutar comandos, push
toolsClient.js        → Backend: busqueda web (Tavily), Wikipedia, video (Seedance), edicion de imagenes
toolsRoutes.js        → Backend: endpoints /api/tools/* en streaming (SSE) para cada herramienta
toolCommands.js        → Backend: detecta "Buscar:", "Investigación profunda:", "Wikipedia:", "Generar video:", "Editar imagen:" en las respuestas de la IA

workspaces/          → Clones reales de repos (uno por sesion, no se versiona — ver .gitignore)
```

El servidor filtra explícitamente qué archivos pueden servirse: `index.html`, `script.js`, `app-shell.js`, `style.css`, `firebase-auth.js` y assets de imagen/fuente. El resto de los `.js` (el código del backend) no se expone vía GET aunque viva en la misma carpeta.

Al conectar un repositorio, el agente crea un perfil estructural leyendo manifiestos, documentación, puntos de entrada y archivos de pruebas. Los diffs seguros se aplican y se verifican automáticamente dentro del workspace; el push a GitHub sigue siendo una acción explícita del usuario.

El frontend nunca habla directo con Groq o GitHub — todo pasa por `/api/*`, que es quien realmente clona, lee, escribe y ejecuta contra un contenedor Linux real (el mismo principio que usan Codex, Claude Code o Copilot Agent, a menor escala).

## Desarrollo local

```bash
npm install
cp .env.example .env   # opcional: pon ahi tus claves (GROQ_API_KEY, TAVILY_API_KEY...)
npm start
```

Abre `http://localhost:3000`.

## Uso rápido

En escritorio, usa la barra lateral para cambiar entre Chat, Archivos, Tareas y Configuración; en móvil, esas secciones siguen en la navegación inferior. Pulsa **Nueva conversación** para volver al inicio. Un ejemplo de petición para un repositorio conectado:

```text
Analiza la estructura del proyecto, detecta un caso extremo que no esté probado y propón una corrección pequeña. Ejecuta las pruebas relacionadas y explícame los archivos que cambiaste.
```

Las pruebas del shell usan las utilidades incluidas con Node.js y no requieren dependencias adicionales:

```bash
npm test
```

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
   - `BYTEPLUS_API_KEY` — clave de pago de BytePlus ModelArk para generar video con Seedance (opcional; sin ella, el agente sigue funcionando normalmente pero sin generar video)
5. Railway asigna la variable `PORT` automaticamente; el servidor ya la lee (`process.env.PORT`), no hay que tocarla.
6. Deploy. El healthcheck vive en `/api/health` y Railway lo usa para saber cuando el servicio esta listo.

Las claves viven **solo** como variables de entorno del servidor: la app no tiene ningún campo para pegar claves en Configuración. GitHub se conecta desde la propia app con OAuth (Device Flow, sin contraseñas), y en Configuración solo se ajusta el comportamiento del agente (multi-agente, modo plan, archivos por turno y modo Auto/Preguntar).

## Proveedores 100% gratuitos

Baro funciona sin pagar nada, sin tarjetas y sin OpenRouter:

1. **Groq** → Llama 3.3 70B (rápido, gratis con `GROQ_API_KEY` de console.groq.com/keys).
2. **Pollinations** → **gratis y sin clave, siempre disponible**: el chat NUNCA muere por falta de claves; sin ninguna configurada responde igual.
3. **Ollama local** → último recurso si el servidor lo tiene instalado.

La cadena se resuelve en cada request (no al arrancar), así que agregar una clave no requiere reiniciar. `GET /api/config` expone el proveedor y modelo activos; la UI muestra "Llama 3.3 70B", "DeepSeek R1" o "Pollinations (gratis)" según corresponda.

`max_tokens` por respuesta: 16,384 en Groq.

## Lo que Baro toma de Astra (sin pagar Astra)

Investigamos la arquitectura publicada de GPT-6 Astra y la reimplementamos a nivel de harness sobre el stack gratuito:

- **Auto-review**: cada diff pasa por un segundo pase del modelo como revisor senior ANTES de aplicarse. Un rechazo no rompe el turno: el motivo vuelve al loop y el agente corrige.
- **Verificación automática**: tras aplicar cambios, se ejecutan los tests del proyecto (Node, Python, etc. según el repo) y el resultado vuelve al loop para auto-corrección en el mismo turno; la app lo muestra como chip permanente del turno (evento `verify`).
- **Memoria de dos capas**: historial de trabajo + notas duraderas de sesión (`Nota: ...`) donde el agente guarda decisiones, intentos fallidos y evidencia verificada — sobreviven a la compactación del contexto.
- **Herramientas en paralelo**: búsquedas, Wikipedia e imágenes independientes se ejecutan a la vez.
- **Auto-reparación**: los diffs que fallan se regeneran contra el contenido real del archivo, nunca se reenvían igual.

## Herramientas nuevas: investigación profunda, búsqueda, Wikipedia, video e imágenes

Estas herramientas funcionan de dos maneras:
1. **Dentro del chat**, la propia IA decide usarlas cuando hacen falta (por ejemplo, si preguntas algo sobre noticias actuales, escribe `Buscar: ...` en su respuesta y el backend ejecuta la busqueda real, mostrando en vivo cada pagina visitada en el log de la conversacion).
2. **Como endpoints directos** en streaming (SSE) bajo `/api/tools/*`, por si el frontend quiere una UI dedicada (por ejemplo un boton "Investigar" o un editor de fotos separado del chat).

### Investigación profunda (estilo Deep Research)
- Para preguntas que merecen análisis en serio, no un dato puntual: el usuario toca la tarjeta **"Investigación profunda"** en la pantalla inicial, o la IA escribe `Investigación profunda: <tema>` en su respuesta.
- El backend lanza **4–6 búsquedas Tavily en paralelo** desde ángulos complementarios (panorama, análisis, datos, actualidad, explicación), **lee las fuentes reales**, deduplica por URL y le pide a la IA que redacte un **informe estructurado con citas [n]** ancladas a las fuentes.
- El chat muestra en vivo el progreso: inicio, cada ángulo, cada fuente leída y la síntesis final. **Nunca inventa fuentes**: si falta `TAVILY_API_KEY`, informa el bloqueo en vez de simular resultados.
- Requiere `TAVILY_API_KEY` (gratis, 1000 búsquedas/mes en tavily.com).

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
- Usa Pollinations (modelo `kontext`, **gratis y sin clave**). Sirve para "edita esta foto", "quitale el fondo", "animala", etc. Para animar una imagen (convertirla en video), el resultado se puede pasar como `referenceImageUrl` a la generacion de video.
- Soporta lotes: si le pasas una lista de fotos con la misma instruccion, las procesa una por una y reporta el progreso en vivo.
- Endpoint: `POST /api/tools/image-edit` `{ imageUrl, instruction }` o `{ images: [...], instruction }` para lotes.

## Seguridad

- Los comandos que el agente puede ejecutar estan en una lista blanca explicita (`commandRunner.js`): `npm`, `npx`, `node`, `python`/`python3`, `pip`, `pytest`, `yarn`, `go`, `cargo`, y subcomandos de solo lectura de `git`. Cualquier otro binario se rechaza.
- `Ejecuta:` tambien es un comando directo del usuario (no solo del modelo): escribir `Crear script: x.py :: ...` y en la linea siguiente `Ejecuta: python3 scripts/x.py` crea y corre el script en el mismo turno, en orden y con la salida real — sin depender de que el modelo repita el comando.
- Cada sesion tiene su propia carpeta de workspace; dos personas usando la misma instancia nunca comparten archivos.
- Las sesiones inactivas por mas de 6 horas se limpian solas (memoria y disco).
- El backend nunca ejecuta comandos con `shell: true` ni concatena strings a un shell — todo va como arrays de argumentos a `execFile`, evitando inyeccion de comandos.

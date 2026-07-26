---
name: Entorno Python de Replit
description: Requisito para que el runner autónomo pueda ejecutar Python en este tipo de proyecto.
---

La lista blanca de comandos no instala runtimes. Para que `python`/`python3` funcionen de verdad en Replit, el módulo Python debe estar declarado en `.replit`; el proceso debe reiniciarse después de habilitarlo.

**Why:** Un primer intento de ejecutar `python3` devolvió `ENOENT` aunque el runner ya aceptaba Python, porque el entorno solo tenía Node.js, web y bash.

**How to apply:** Antes de declarar soporte Python listo, comprobar `command -v python3`, añadir un módulo Python compatible si falta y ejecutar una validación real dentro de `commandRunner`.
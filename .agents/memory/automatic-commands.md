---
name: Comandos automáticos del agente
description: Regla para que las solicitudes de comandos de la IA se ejecuten y se encadenen automáticamente.
---

Cuando la IA emite una instrucción `Ejecuta:` en una línea independiente, el backend debe interpretarla como una solicitud de herramienta, ejecutarla con argumentos separados y devolver stdout/stderr al siguiente turno del modelo. El comando nunca debe pasar por un shell y debe respetar la lista blanca del agente.

**Why:** Mostrarle al usuario un comando para copiar rompe el flujo autónomo y deja al modelo sin la información que necesita para completar el análisis.

**How to apply:** Mantener límites de rondas y comandos por ronda, registrar cada ejecución en la actividad de la sesión y rechazar metacaracteres o binarios/subcomandos no permitidos.
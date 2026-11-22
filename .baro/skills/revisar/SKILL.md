---
name: revisar
description: Revisión de código: busca errores, problemas de seguridad y regresiones antes de dar algo por terminado.
when: revisar código, buscar errores, problemas de seguridad, regresiones
label: revisión de código
defaultTask: Revisa el código del proyecto y resume los hallazgos por prioridad.
---

# Revisar código

Cuando revises código, sigue estos pasos:

1. Lee los archivos relevantes (no opines sin leerlos).
2. Busca primero lo que rompe o pone en riesgo el proyecto: errores que hacen fallar el programa, datos expuestos, entradas sin validar, accesos sin permiso.
3. Después, lo que puede romperse al cambiar algo: partes que dependen de lo que tocaste, pruebas que cubren ese código, casos borde.
4. Escribe tu informe como texto de tu respuesta, directamente (no como herramienta ni como línea de comando): los hallazgos en orden P0 (bloqueante, hay que arreglarlo ya), P1 (importante, conviene arreglarlo), P2 (menor, mejora). Cada hallazgo con archivo:línea y una frase de qué pasa.
5. Termina con un veredicto de una línea: si el código está listo o qué falta.
6. Tu trabajo termina cuando escribes el informe: no lo dejes para después de otra herramienta.
7. Nunca apliques cambios al revisar: solo informa.

---
name: verificar
description: Verificar con pruebas reales antes de declarar que algo funciona: ejecuta los tests y confirma el resultado.
when: verificar, probar, tests, comprobar que funciona, antes de terminar
label: verificación con pruebas
defaultTask: Verifica el proyecto con sus pruebas y resume el resultado.
---

# Verificar con pruebas

Antes de decir que algo funciona:

1. Encuentra cómo se prueba el proyecto (package.json, README, archivos de tests).
2. Ejecuta las pruebas de verdad y lee la salida completa.
3. Si fallan, di qué falló y por qué, y corrígelo antes de seguir.
4. Si no hay pruebas, haz una comprobación real equivalente (ejecutar el programa, probar la función a mano) y di cuál fue.
5. Nunca declares éxito sin haber visto el resultado de la comprobación.

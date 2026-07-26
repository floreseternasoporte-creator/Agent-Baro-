---
name: Aplicación segura de diffs
description: Reglas duraderas para aplicar cambios generados por IA sobre workspaces reales.
---

Los diffs generados por IA deben compararse con el contenido actual del disco, no con una copia histórica del chat. Las diferencias inocuas de finales de línea, espacios finales y desplazamiento de contexto pueden tolerarse de forma limitada; una línea que el diff elimina siempre debe coincidir. Si no coincide, no se debe escribir el archivo.

**Why:** El historial de conversación puede contener versiones anteriores del archivo y los modelos pueden conservar contexto obsoleto, lo que produce parches que ya no aplican.

**How to apply:** Cada solicitud de edición debe incluir una lectura reciente del archivo y el aplicador debe preservar el contenido original cuando la validación falla, informando si el cambio ya estaba aplicado.
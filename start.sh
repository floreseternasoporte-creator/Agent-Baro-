#!/bin/bash
# ═══════════════════════════════════════════════════════
# start.sh — Arranque de DevAgent en Railway
# 1. Inicia Ollama en background
# 2. Espera a que el servidor Ollama responda
# 3. Arranca Node.js
# ═══════════════════════════════════════════════════════
set -e

echo "[DevAgent] Iniciando Ollama..."
ollama serve &

echo "[DevAgent] Esperando que Ollama esté listo..."
MAX_WAIT=60
WAITED=0
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "[DevAgent] ⚠️  Ollama tardó demasiado. Continuando de todas formas..."
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
echo "[DevAgent] Ollama listo ✓ (${WAITED}s)"

echo "[DevAgent] Iniciando servidor Node.js en puerto ${PORT:-5000}..."
exec node server.js

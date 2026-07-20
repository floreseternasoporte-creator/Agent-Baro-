# ═══════════════════════════════════════════════════════
# Dockerfile — DevAgent con modelo local (Ollama)
# Lleva el modelo qwen2.5-coder:1.5b baked dentro de la
# imagen para que Railway no lo descargue en cada arranque.
#
# Requiere ≥ 2 GB RAM en Railway (recomendado 4 GB).
# ═══════════════════════════════════════════════════════

FROM node:20-slim

# Dependencias del sistema + Ollama
RUN apt-get update && \
    apt-get install -y curl ca-certificates zstd && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.ai/install.sh | sh

WORKDIR /app

# Dependencias Node (capa separada para mejor cache)
COPY package*.json ./
RUN npm ci --production

# Código fuente
COPY . .

# Pre-descargar el modelo en tiempo de build para que esté
# dentro de la imagen y no haya espera al arrancar.
ENV OLLAMA_MODELS=/root/.ollama/models
RUN ollama serve & \
    sleep 12 && \
    ollama pull qwen2.5-coder:1.5b && \
    pkill -f "ollama serve" || true

EXPOSE 5000

CMD ["bash", "start.sh"]

FROM node:20-slim

# Sistema + Ollama + git
RUN apt-get update && \
    apt-get install -y curl ca-certificates zstd git --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.ai/install.sh | sh

WORKDIR /app

# node_modules ya viene en el repo — no hace falta npm install
COPY . .

# Modelo bakeado en la imagen: sin espera al arrancar
ENV OLLAMA_MODELS=/root/.ollama/models
RUN ollama serve & \
    sleep 15 && \
    ollama pull qwen2.5-coder:1.5b && \
    pkill -f "ollama serve" || true

EXPOSE 3000
CMD ["bash", "start.sh"]

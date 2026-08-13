FROM node:20-slim

RUN apt-get update && \
    apt-get install -y git ca-certificates --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos primero solo los manifiestos para aprovechar la cache de
# capas de Docker: si package.json no cambia, esta capa se reusa y
# el build es mucho mas rapido. NUNCA confiamos en que node_modules
# venga commiteado en el repo real (el .gitignore del proyecto lo
# excluye, como es estandar) — esa suposicion era la causa exacta
# del crash "Cannot find module 'dotenv'" al desplegar: el repo real
# en GitHub no trae node_modules, asi que sin este npm install el
# contenedor arranca sin dependencias.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

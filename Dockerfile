FROM node:20-slim

RUN apt-get update && \
    apt-get install -y git ca-certificates --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node_modules ya viene en el repo — no hace falta npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

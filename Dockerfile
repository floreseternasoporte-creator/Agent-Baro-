FROM node:20-slim

# Instalar dependencias en /deps (fuera de /app)
# Así sobreviven aunque Railway monte el código fuente sobre /app
COPY package*.json /deps/
RUN cd /deps && npm install --omit=dev

WORKDIR /app
COPY . .

# Decirle a Node.js dónde buscar los módulos
ENV NODE_PATH=/deps/node_modules

EXPOSE 3000
CMD ["node", "server.js"]

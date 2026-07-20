FROM node:20-slim

WORKDIR /app

# Install dependencies first (separate layer for better caching)
COPY package*.json ./
RUN npm ci --production

# Copy source code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]

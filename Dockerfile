FROM node:20-slim
RUN apt-get update && apt-get install -y git --no-install-recommends && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]

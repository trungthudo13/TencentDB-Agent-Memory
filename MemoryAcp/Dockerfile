FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
RUN mkdir -p /data/codex && chown -R node:node /data
USER node
ENV MEMORY_ACP_HOST=0.0.0.0 MEMORY_ACP_CODEX_HOME=/data/codex
EXPOSE 8097
CMD ["node", "src/index.js"]

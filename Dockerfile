FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    DATA_DIR=/app/data

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/api/health').then(async r => { const body = await r.json(); if (!r.ok || !body.ok || !body.desktop?.healthy) process.exit(1); }).catch(() => process.exit(1))"]

CMD ["node", "server/index.js"]

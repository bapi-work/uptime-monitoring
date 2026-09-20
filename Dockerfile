FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=3300
ENV NODE_ENV=production
EXPOSE 3300

VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3300/healthz || exit 1

CMD ["node", "server.js"]

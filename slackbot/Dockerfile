FROM node:20-slim AS builder
WORKDIR /app
COPY slackbot/package*.json ./
RUN npm install
COPY slackbot/ .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY slackbot/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN useradd -u 1001 -m appuser && chown -R appuser /app
USER appuser
CMD ["node", "dist/index.js"]

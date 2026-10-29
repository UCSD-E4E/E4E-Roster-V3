# Build context must be the repo root (set in docker-compose.yml).
# This lets us copy both backend/ and frontend/static/ into the image.

FROM node:24.22.1-bookworm-slim AS builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build && rm -f dist/scripts/demo-integrations.js

FROM node:24.22.1-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY backend/views ./views
# Static assets served from /app/public; STATIC_DIR env var points here
COPY frontend/static ./public
# Runtime code/assets are read-only; avoid rewriting ownership of node_modules.
RUN useradd -u 1001 -m appuser
USER appuser
EXPOSE 3000
CMD ["node", "dist/server.js"]

# Build context must be the repo root (set in docker-compose.yml).
# This lets us copy both backend/ and frontend/static/ into the image.

FROM node:20-slim AS builder
WORKDIR /app
COPY backend/package*.json ./
RUN npm install
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
COPY backend/views ./views
# Static assets served from /app/public; STATIC_DIR env var points here
COPY frontend/static ./public
EXPOSE 3000
CMD ["node", "dist/server.js"]

# Stage 1 — build frontend (Vite SPA)
FROM node:20-alpine AS frontend-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2 — build backend (TypeScript + native better-sqlite3 bindings)
FROM node:20-alpine AS backend-builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Stage 3 — slim production image
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=frontend-builder /app/web/dist ./dist/public
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && mkdir -p /app/data
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]

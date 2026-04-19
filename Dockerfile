# Stage 1 — builder
# Needs python3 + make + g++ to compile better-sqlite3 native bindings
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

# Stage 2 — production
# Slim runtime — no build tools needed since native .node binary is already compiled
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && mkdir -p /app/data
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]

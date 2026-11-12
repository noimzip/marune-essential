# Stage 1: Build TypeScript source
FROM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Stage 2: Lightweight Production Runner
FROM node:24-alpine AS runner

WORKDIR /app

# Set timezone to Asia/Tokyo and install timezone data
RUN apk add --no-cache tzdata
ENV TZ=Asia/Tokyo
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Expose HTTP health check port
EXPOSE 8080

CMD ["node", "dist/index.js"]

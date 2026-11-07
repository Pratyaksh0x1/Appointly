# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/
COPY apps/dashboard/package*.json ./apps/dashboard/

# Install all dependencies
RUN npm ci

# Copy source files
COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# Build packages
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install non-root user
RUN addgroup -S appointly && adduser -S appointly -G appointly

# Copy package descriptors
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/api/package*.json ./apps/api/
COPY apps/dashboard/package*.json ./apps/dashboard/

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/dashboard ./apps/dashboard
COPY --from=builder /app/public ./public
COPY docs ./docs

# Set ownership to non-root user
USER appointly

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]


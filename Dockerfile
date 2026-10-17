# syntax=docker/dockerfile:1
# One image for the API and the worker (they differ only in the command), plus a `migrate`
# target that applies database migrations. Debian slim, not Alpine: argon2 ships a glibc
# prebuild, so nothing compiles natively. Build: docker build -t fundra .

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ─── Dependencies (all, for building) ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate` (no database needed).
RUN npm ci

# ─── Build ───────────────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The generated Prisma client is compiled into dist/ with the rest.
RUN npx prisma generate && npm run build

# ─── Production dependencies only ────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts: postinstall needs the Prisma CLI (a dev dependency), and the client is
# already generated and compiled in the build stage.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─── Migrations (one-shot: docker compose run --rm migrate) ─────────────────────────────
FROM deps AS migrate
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ─── Runtime: API (default) or worker ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# KYC documents and statements (local disk until S3): a volume in compose.
RUN mkdir -p storage && chown node:node storage
USER node
EXPOSE 3000
# Liveness only: readiness (dependencies) is for the orchestrator to route traffic.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The worker uses the same image: command `node dist/jobs/workers.js`.
CMD ["node", "dist/server.js"]

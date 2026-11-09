# syntax=docker/dockerfile:1.7
#
# Orbik's three images, built from the repository root:
#
#   docker build -f deploy/Dockerfile --target web    -t orbik-web .
#   docker build -f deploy/Dockerfile --target api    -t orbik-api .
#   docker build -f deploy/Dockerfile --target agents -t orbik-agents .
#
# `compose.yaml` at the root builds all three. `agents` runs the worker and the scheduler (one
# image, two commands) and carries Chromium and fallback fonts for the Design system agent.

ARG NODE_VERSION=24.14.0

# ---- The toolchain: Node and pnpm, at the versions package.json pins -------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /orbik

# ---- Every dependency of the workspace, fetched from the lockfile alone, so that changing the
# source does not fetch them again -------------------------------------------------------------
FROM base AS fetched
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile --store-dir /pnpm/store

# ---- The web app, built as Next's self-contained server ------------------------------------
FROM fetched AS web-build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
# NEXT_PUBLIC_API_BASE_URL is left unset on purpose: the app then calls the API on its own origin,
# which the proxy in compose.yaml routes, so one image serves any hostname.
RUN NEXT_OUTPUT=standalone pnpm --dir frontend run build

FROM node:${NODE_VERSION}-bookworm-slim AS web
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3100 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /orbik
COPY --from=web-build --chown=node:node /orbik/frontend/.next/standalone ./
COPY --from=web-build --chown=node:node /orbik/frontend/.next/static ./frontend/.next/static
USER node
EXPOSE 3100
CMD ["node", "frontend/server.js"]

# ---- The API, the worker and the scheduler: production dependencies only --------------------
# Not from `fetched`: `pnpm fetch` puts every package of the lockfile into node_modules, and the
# web app's (Next, its compiler, TypeScript) are most of them. The web app is taken out of the
# workspace and the rest installed from the same package cache, which `fetched` has filled.
FROM base AS server-build
COPY . .
RUN rm -rf frontend && sed -i '/^  - frontend$/d' pnpm-workspace.yaml
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prefer-offline --frozen-lockfile --prod --store-dir /pnpm/store

FROM node:${NODE_VERSION}-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /orbik
COPY --from=server-build --chown=node:node /orbik/package.json /orbik/pnpm-workspace.yaml ./
COPY --from=server-build --chown=node:node /orbik/node_modules ./node_modules
COPY --from=server-build --chown=node:node /orbik/packages ./packages
COPY --from=server-build --chown=node:node /orbik/backend ./backend
COPY --from=server-build --chown=node:node /orbik/agents ./agents
USER node
WORKDIR /orbik/backend
EXPOSE 4100
CMD ["node", "src/server.js"]

FROM api AS agents
USER root
# Chromium for the Design system agent (chrome-launcher finds it through
# CHROME_PATH), and the fallback fonts a site's `Arial` or `system-ui` render in on a bare host.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium
USER node
WORKDIR /orbik/agents
CMD ["node", "src/worker.js"]

# syntax=docker/dockerfile:1.7
# SWEEP: one Node process serving the API (Hono + node:sqlite) and the built web app.
# Targets: `runtime` (default, production) and `test` (runs the unit/integration suites).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- dependencies (cached on lockfile + manifests) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# An optional build secret `ca_bundle` lets builds behind a TLS-inspecting proxy trust it;
# it is mounted only for this step and never stored in the image.
RUN --mount=type=secret,id=ca_bundle,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    sh -c 'if [ -f /run/secrets/ca_bundle ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca_bundle; fi; \
      corepack enable && pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile'

# ---------- build ----------
FROM deps AS build
COPY . .
RUN pnpm build

# ---------- test (docker build --target test ...) ----------
FROM build AS test
CMD ["pnpm", "test"]

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    SWEEP_STATIC_DIR=/app/web \
    SWEEP_DB_PATH=/data/sweep.db \
    SWEEP_MAP_CACHE_DIR=/data/map-cache
WORKDIR /app
# The server bundle is self-contained (esbuild); no node_modules are needed at runtime.
COPY --from=build --chown=node:node /app/apps/server/dist ./server
COPY --from=build --chown=node:node /app/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

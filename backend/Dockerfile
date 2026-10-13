# GlobalHealth Corp -> SHC Platform ingestion pipeline
#
#   docker build -t shc-ingest:1.0.0 ./backend
#   docker run --rm -e SHC_API_TOKEN=... \
#     -v "$PWD/backend/data:/data/input:ro" -v "$PWD/output:/data/output" shc-ingest:1.0.0
#
# For reproducible builds, pin NODE_IMAGE to a digest from your registry,
# e.g. --build-arg NODE_IMAGE=node:24-alpine@sha256:<digest>
ARG NODE_IMAGE=node:24-alpine

# ---- 1. deps: full dependency tree; this layer is cached until the lockfile changes
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- 2. build: compile TypeScript to dist/ ------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- 3. prod-deps: runtime dependencies only (no compiler, no test tooling) --------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# ---- 4. runtime -----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="shc-ingest" \
      org.opencontainers.image.description="GlobalHealth Corp legacy patient CSV -> SHC Platform ingestion pipeline" \
      org.opencontainers.image.version="1.0.0"

# tini runs as PID 1: it forwards SIGTERM so in-flight batches finish cleanly, and reaps zombies.
RUN apk add --no-cache tini

# Non-secret defaults only. SHC_API_TOKEN / SHC_API_TOKEN_FILE are supplied at run time.
# HOST is deliberately not set: the default `ingest` command listens on nothing, and the
# optional `mock-api` / `serve` commands should only be exposed on purpose (-e HOST=0.0.0.0).
ENV NODE_ENV=production \
    INPUT_FILE=/data/input/patients.csv \
    OUTPUT_DIR=/data/output \
    LOG_FORMAT=json

WORKDIR /app
# Application files stay root-owned, so the runtime user can read them but never modify them.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The only path the unprivileged user can write to is the output directory.
RUN mkdir -p /data/input /data/output && chown node:node /data/output

USER node

ENTRYPOINT ["/sbin/tini", "--", "node", "dist/cli.js"]
CMD ["ingest"]

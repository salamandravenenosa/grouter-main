# syntax=docker/dockerfile:1.7

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS builder

WORKDIR /app

# Install deps first (cache-friendly layer)
# --ignore-scripts: skip the `prepare` lifecycle — it triggers `prebuild`
# (scripts/embed-logos.ts) which isn't in the build context yet.
# The explicit `bun run build` below runs the full chain after sources are copied.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Copy sources and build the single-file binary
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY index.ts ./
RUN bun run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS runtime

# tini gives us proper PID-1 signal handling (clean Ctrl+C / docker stop)
RUN apk add --no-cache tini ca-certificates \
 && addgroup -S grouter \
 && adduser  -S -G grouter -h /data grouter \
 && mkdir -p /data/.grouter \
 && chown -R grouter:grouter /data

ENV HOME=/data \
    NODE_ENV=production \
    GROUTER_IN_DOCKER=1 \
    GROUTER_RESTORE_SNAPSHOT=if-empty \
    GROUTER_SNAPSHOT_DIR=/app/state/grouter-local

WORKDIR /app

# Pull only the compiled binary — no node_modules, no sources
COPY --from=builder /app/dist/grouter /usr/local/bin/grouter
COPY state ./state
COPY scripts/container-entrypoint.sh /app/scripts/container-entrypoint.sh
RUN chmod 755 /usr/local/bin/grouter /app/scripts/container-entrypoint.sh

# Some PaaS volume mounts are root-owned and not writable by non-root users.
USER root

# Router :3099 + per-provider range :3100-3110
EXPOSE 3099 3100-3110

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'wget -qO- "http://127.0.0.1:${PORT:-3099}/health" >/dev/null 2>&1 || exit 1'

# `docker run … add`, `… list`, etc. Pass any subcommand straight through.
ENTRYPOINT ["/app/scripts/container-entrypoint.sh"]
CMD ["serve", "fg"]

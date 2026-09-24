# syntax=docker/dockerfile:1
# Requires BuildKit (RUN --mount=type=cache, multi-stage COPY --from).

# Shell base: bun + a shell, used by every build-time stage
FROM oven/bun:1.4.0 AS base
WORKDIR /app

# turbo isolated here so it never reaches the runner; the version is derived
# from the root package.json devDependency so a Dependabot turbo bump can
# never drift from the image (previously a hardcoded ARG guarded by CI, #120).
FROM base AS toolchain
COPY package.json ./
RUN bun add -g turbo@"$(bun --print 'require("./package.json").devDependencies.turbo')"

# 1) Prune the monorepo to the subset @intervals-mcp/server needs.
#    Produces /app/out/json (package.json files), /app/out/full (sources),
#    and /app/out/bun.lock (subset lockfile).
FROM toolchain AS pruner
COPY . .
RUN turbo prune @intervals-mcp/server --docker

# 2) Build: full deps then turbo build of the server's dependencies, which
#    runs every MCP App package's vite build (packages/*/dist/app.html).
FROM toolchain AS builder
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
RUN turbo run build --filter=@intervals-mcp/server^...

# 3) Prod-only deps plus the data dir, prepared in a SHELL stage.
#    Distroless cannot RUN, so the install, mkdir, and chown happen here.
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --production
RUN mkdir -p /app/data && chown -R 65534:65534 /app

# 4) Distroless runner: COPY only. nonroot (65534), no shell, ENTRYPOINT is bun.
FROM oven/bun:1.4.0-distroless AS runner
WORKDIR /app

# MCP registry ownership proof: publish-mcp.yml publishes server.json as an OCI
# package, and the registry pulls the image to check this label matches the
# server name. Must stay in sync with `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.ljcl/intervals-mcp"
COPY --from=prod-deps --chown=65534:65534 /app ./
COPY --from=builder  --chown=65534:65534 /app/apps/server/src ./apps/server/src
COPY --from=builder  --chown=65534:65534 /app/apps/server/scripts ./apps/server/scripts
# JIT workspace dependency: @intervals-mcp/data has no build step, its
# `exports` points straight at ./src/index.ts, and bun resolves that at
# runtime. Without the sources the image builds green and dies on the
# first import (#341 shipped exactly that). dockerRuntime.test.ts pins it.
COPY --from=builder  --chown=65534:65534 /app/packages/data/src ./packages/data/src
COPY --from=builder  --chown=65534:65534 /app/packages/activity-chart/dist ./packages/activity-chart/dist
COPY --from=builder  --chown=65534:65534 /app/packages/cadence-trends/dist ./packages/cadence-trends/dist
COPY --from=builder  --chown=65534:65534 /app/packages/route-map/dist ./packages/route-map/dist
COPY --from=builder  --chown=65534:65534 /app/packages/activity-segments/dist ./packages/activity-segments/dist
COPY --from=builder  --chown=65534:65534 /app/packages/training-load/dist ./packages/training-load/dist
COPY --from=builder  --chown=65534:65534 /app/packages/compare-activities/dist ./packages/compare-activities/dist
COPY --from=builder  --chown=65534:65534 /app/packages/activity-zones/dist ./packages/activity-zones/dist
COPY --from=builder  --chown=65534:65534 /app/packages/segment-progress/dist ./packages/segment-progress/dist
COPY --from=builder  --chown=65534:65534 /app/packages/fitness-trend/dist ./packages/fitness-trend/dist

USER 65534:65534
ENV NODE_ENV=production
EXPOSE 3000

# Exec-form healthcheck: no shell, no wget. Full bun path because HEALTHCHECK
# does not route through ENTRYPOINT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/bun","--eval","fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# ENTRYPOINT is already /usr/local/bin/bun, so CMD omits the leading "bun".
CMD ["run","apps/server/src/index.ts"]

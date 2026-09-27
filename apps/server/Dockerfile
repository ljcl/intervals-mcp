# syntax=docker/dockerfile:1
# Requires BuildKit (RUN --mount=type=cache, multi-stage COPY --from).

# Shell base: bun + a shell, used by every build-time stage
FROM oven/bun:1.4.2 AS base
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
#    Then bundle the server into one file. Every npm dependency and
#    @intervals-mcp/data (JIT TypeScript) is inlined, so the runner needs no
#    node_modules install: `bun install --production` over the pruned
#    workspace also installed the apps' React/Recharts/maplibre and, through
#    vite-config's peers, Vite and Rolldown native binaries (#89), none of
#    which the server runs.
FROM toolchain AS builder
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
RUN turbo run build --filter=@intervals-mcp/server^...
RUN bun build apps/server/src/index.ts --target=bun --outdir apps/server/dist --sourcemap=linked

# 3) Distroless runner: COPY only. nonroot (65534), no shell, ENTRYPOINT is bun.
FROM oven/bun:1.4.2-distroless AS runner
WORKDIR /app

# MCP registry ownership proof: publish-mcp.yml publishes server.json as an OCI
# package, and the registry pulls the image to check this label matches the
# server name. Must stay in sync with `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.ljcl/intervals-mcp"
# Manifests only: the root package.json that version.ts reads, and each
# app's `exports` map that its app.html resolves through.
COPY --from=pruner   --chown=65534:65534 /app/out/json/ ./
COPY --from=builder  --chown=65534:65534 /app/apps/server/dist ./apps/server/dist
# The workspace symlinks bun install made for the server (relative, so they
# land on /app/packages/*). APP_RESOURCES resolves each app.html through them
# at runtime; nothing else in node_modules is read. dockerRuntime.test.ts
# checks that every runtime-resolved specifier lands inside a COPY below.
COPY --from=builder  --chown=65534:65534 /app/apps/server/node_modules/@intervals-mcp ./apps/server/node_modules/@intervals-mcp
COPY --from=builder  --chown=65534:65534 /app/packages/activity-chart/dist ./packages/activity-chart/dist
COPY --from=builder  --chown=65534:65534 /app/packages/cadence-trends/dist ./packages/cadence-trends/dist
COPY --from=builder  --chown=65534:65534 /app/packages/route-map/dist ./packages/route-map/dist
COPY --from=builder  --chown=65534:65534 /app/packages/training-load/dist ./packages/training-load/dist
COPY --from=builder  --chown=65534:65534 /app/packages/compare-activities/dist ./packages/compare-activities/dist
COPY --from=builder  --chown=65534:65534 /app/packages/activity-zones/dist ./packages/activity-zones/dist
COPY --from=builder  --chown=65534:65534 /app/packages/fitness-trend/dist ./packages/fitness-trend/dist

USER 65534:65534
ENV NODE_ENV=production
EXPOSE 3000

# Exec-form healthcheck: no shell, no wget. Full bun path because HEALTHCHECK
# does not route through ENTRYPOINT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/bun","--eval","fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# ENTRYPOINT is already /usr/local/bin/bun, so CMD omits the leading "bun".
CMD ["run","apps/server/dist/index.js"]

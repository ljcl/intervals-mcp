#!/usr/bin/env bash
# Starts a built server image and checks it the way a user would meet it:
# healthy, serving the MCP surface, refusing bad config, and stopping cleanly.
# docker.yml runs it on every build leg before anything is published;
# dockerRuntime.test.ts only reads the repo tree, so it cannot see what the
# build context left out, a runtime import of a devDependency, a broken CMD or
# HEALTHCHECK, or a permission problem under uid 65534. The container listens
# on a non-default PORT, which proves the image's HEALTHCHECK reads PORT.
#
# Usage: scripts/docker-smoke.sh <image-ref>
# Needs docker, curl and jq. Run from the repo root (it reads package.json and
# the tool-surface lock).
set -euo pipefail

IMAGE="${1:?usage: docker-smoke.sh <image-ref>}"
TOKEN="smoke-token"
NAME="intervals-mcp-smoke-$$"
LOCK="apps/server/tool-surface.lock.json"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
pass() { echo "ok: $*"; }

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && docker inspect "$NAME" >/dev/null 2>&1; then
    echo "--- container logs ---" >&2
    docker logs "$NAME" >&2 || true
  fi
  docker rm -f "$NAME" "$NAME-config" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The healthcheck overrides only shorten the timing; the image's own
# HEALTHCHECK command is what runs. A dummy key passes startup, because
# startup checks only that a key is set, not that intervals.icu accepts it,
# and the smoke checks never call intervals.icu. TZ is set, so startup skips
# the athlete time zone lookup too. The short token only logs a startup
# WARNING.
docker run -d --name "$NAME" \
  -e INTERVALS_API_KEY=smoke-dummy \
  -e MCP_AUTH_TOKEN="$TOKEN" \
  -e PORT=8080 \
  -e TZ=Australia/Sydney \
  --health-interval=1s --health-start-period=30s --health-retries=3 \
  -p 127.0.0.1::8080 \
  "$IMAGE" >/dev/null

health=""
for _ in $(seq 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$NAME")"
  [ "$health" = healthy ] || [ "$health" = unhealthy ] && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != true ]; then
    health="exited with code $(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
    break
  fi
  sleep 1
done
if [ "$health" != healthy ]; then
  fail "container never reported healthy ($health)"
  exit 1
fi
pass "healthcheck reports healthy"

# The server runs as one bundle; its only node_modules entries are the
# @intervals-mcp workspace links it resolves app.html through. Anything else
# means an install tree (React, Vite, native binaries) is back in the image.
installed="$(docker run --rm --entrypoint /usr/local/bin/bun "$IMAGE" -e '
  const { readdirSync } = require("fs");
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.name === "node_modules") {
        for (const m of readdirSync(p)) found.push(p + "/" + m);
      } else if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  walk("/app");
  console.log(found.filter((p) => p !== "/app/apps/server/node_modules/@intervals-mcp").join("\n"));
')"
size="$(docker image inspect -f '{{.Size}}' "$IMAGE" | numfmt --to=iec)"
if [ -z "$installed" ]; then
  pass "no node_modules install tree ($size uncompressed)"
else
  fail "the image carries installed packages:"
  echo "$installed" >&2
fi
BASE="http://$(docker port "$NAME" 8080/tcp | head -1)"

expected_version="$(jq -r .version package.json)"
version="$(curl -fsS "$BASE/health" | jq -r .version)"
if [ "$version" = "$expected_version" ]; then
  pass "/health version $version"
else
  fail "/health version is '$version', package.json says '$expected_version'"
fi

# The zone's source sits behind the token, with the rest of the detail.
zone_source="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/health" |
  jq -r .time_zone_source)"
if [ "$zone_source" = env ]; then
  pass "/health time zone source env"
else
  fail "/health time_zone_source is '$zone_source', expected 'env'"
fi

status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -d '{}')"
if [ "$status" = 401 ]; then
  pass "/mcp without the token is 401"
else
  fail "/mcp without the token returned $status, expected 401"
fi

# One 2026-07-28 request: the envelope rides in params._meta, and Mcp-Name
# repeats the name or uri the body carries. Prints the JSON-RPC response,
# picked out of an SSE stream if the server chose to stream.
id=0
mcp() {
  local method="$1" params="${2:-}" name
  [ -n "$params" ] || params='{}'
  id=$((id + 1))
  name="$(jq -r '.name // .uri // empty' <<<"$params")"
  local body
  body="$(jq -cn --argjson id "$id" --arg method "$method" --argjson params "$params" '{
    jsonrpc: "2.0", id: $id, method: $method,
    params: ($params + {_meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {name: "docker-smoke", version: "1.0"},
      "io.modelcontextprotocol/clientCapabilities": {}
    }})
  }')"
  curl -sS -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Mcp-Method: $method" \
    ${name:+-H "Mcp-Name: $name"} \
    -d "$body" |
    sed -n 's/^data: //p;/^{/p' |
    jq -c --argjson id "$id" 'select(.id == $id)'
}

discover="$(mcp server/discover)"
if jq -e '.result.capabilities.tools and .result.capabilities.resources' <<<"$discover" >/dev/null; then
  pass "server/discover advertises tools and resources"
else
  fail "server/discover: $discover"
fi

# Every tool the lock fingerprints must be served, and nothing else.
served="$(mcp tools/list | jq -r '.result.tools[].name' | sort)"
locked="$(jq -r '.tools | keys[]' "$LOCK" | sort)"
if [ -n "$served" ] && [ "$served" = "$locked" ]; then
  pass "tools/list serves the $(wc -l <<<"$served" | tr -d ' ') locked tools"
else
  fail "tools/list differs from $LOCK:"
  diff <(echo "$locked") <(echo "$served") >&2 || true
fi

uris="$(mcp resources/list | jq -r '.result.resources[].uri | select(startswith("ui://"))')"
if [ -z "$uris" ]; then
  fail "resources/list lists no ui:// app resources"
fi
for uri in $uris; do
  html="$(mcp resources/read "$(jq -cn --arg uri "$uri" '{uri: $uri}')" | jq -r '.result.contents[0].text // empty')"
  if [ "${#html}" -gt 1000 ] && grep -qi '<html' <<<"$html"; then
    pass "resources/read $uri (${#html} chars)"
  else
    fail "resources/read $uri returned no app HTML"
  fi
done

# A tool call with bad arguments runs the dispatcher and schema validation
# without reaching intervals.icu, and must come back as an isError result.
call="$(mcp tools/call '{"name":"get-activity","arguments":{}}')"
if jq -e '.result.isError == true and (.result.content[0].text | startswith("❌"))' <<<"$call" >/dev/null; then
  pass "tools/call with bad arguments returns an isError result"
else
  fail "tools/call with bad arguments: $call"
fi

# A 2025-era handshake is rejected with the supported revision.
init="$(curl -sS -w '\n%{http_code}' -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0"}}}')"
init_status="$(tail -1 <<<"$init")"
init_code="$(sed '$d' <<<"$init" | jq -r '.error.code')"
if [ "$init_status" = 400 ] && [ "$init_code" = -32022 ]; then
  pass "initialize rejected with 400 / -32022"
else
  fail "initialize returned HTTP $init_status, code $init_code"
fi

# Bad config stops startup with exit 1 and one line per bad variable. Vitest
# never runs index.ts, so this is the check that the startup gate runs on the
# image's Bun. The wait polls like the health wait above, so it needs no GNU
# timeout. cleanup removes the container.
docker run -d --name "$NAME-config" \
  -e INTERVALS_API_KEY=smoke-dummy \
  -e TZ=Australia/Sydny \
  -e PORT=abc \
  "$IMAGE" >/dev/null
for _ in $(seq 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME-config")" = true ] || break
  sleep 1
done
bad="$(docker logs "$NAME-config" 2>&1)"
if [ "$(docker inspect -f '{{.State.Running}}' "$NAME-config")" = true ]; then
  fail "bad TZ and PORT: the server still runs after 30 s, output:"
  echo "$bad" >&2
else
  bad_status="$(docker inspect -f '{{.State.ExitCode}}' "$NAME-config")"
  if [ "$bad_status" = 1 ] &&
    grep -qF 'TZ is "Australia/Sydny"' <<<"$bad" &&
    grep -qF 'PORT is "abc"' <<<"$bad"; then
    pass "bad TZ and PORT stop startup with exit 1, naming both"
  else
    fail "bad TZ and PORT: exit $bad_status, output:"
    echo "$bad" >&2
  fi
fi

# SIGTERM drains and exits 0 well inside docker's 10 s default, which is what
# compose's stop_grace_period and SHUTDOWN_GRACE_MS are sized against.
start=$(date +%s)
docker stop -t 10 "$NAME" >/dev/null
elapsed=$(($(date +%s) - start))
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
if [ "$exit_code" = 0 ] && [ "$elapsed" -lt 10 ]; then
  pass "docker stop exits 0 in ${elapsed}s"
else
  fail "docker stop took ${elapsed}s, exit code $exit_code"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures smoke check(s) failed" >&2
  exit 1
fi
echo "all smoke checks passed"

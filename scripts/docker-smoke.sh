#!/usr/bin/env bash
# Starts a built server image and checks it the way a user would meet it:
# healthy, serving the MCP surface, and stopping cleanly. docker.yml runs it on
# every build leg before anything is published; dockerRuntime.test.ts only
# reads the repo tree, so it cannot see what the build context left out, a
# runtime import of a devDependency, a broken CMD or HEALTHCHECK, or a
# permission problem under uid 65534.
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
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The healthcheck overrides only shorten the timing; the image's own
# HEALTHCHECK command is what runs. A dummy key passes startup, which only
# checks that one is set, and the smoke checks never call intervals.icu.
docker run -d --name "$NAME" \
  -e INTERVALS_API_KEY=smoke-dummy \
  -e MCP_AUTH_TOKEN="$TOKEN" \
  --health-interval=1s --health-start-period=30s --health-retries=3 \
  -p 127.0.0.1::3000 \
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
BASE="http://$(docker port "$NAME" 3000/tcp | head -1)"

expected_version="$(jq -r .version package.json)"
version="$(curl -fsS "$BASE/health" | jq -r .version)"
if [ "$version" = "$expected_version" ]; then
  pass "/health version $version"
else
  fail "/health version is '$version', package.json says '$expected_version'"
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

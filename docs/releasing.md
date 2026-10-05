# Releasing

Releases are automated by release-please
(`.github/workflows/release-please.yml`). The one thing a human (or agent) must
get right is the PR title.

## PR titles are Conventional Commits

PRs are squash-merged, so the **PR title becomes the only commit on `main`**.
The title must be a Conventional Commit, or release-please sees no releasable
change and silently skips (the run still reports success). The `pr-title.yml`
workflow rejects non-conforming titles, and the repo squash setting is pinned
to `PR_TITLE` so the title is always what lands. Branch commits can be messy;
only the PR title matters.

Branch protection on `main` requires three checks: `check` (ci.yml),
`pr-title` (pr-title.yml) and `docker-ok` (docker.yml's aggregator, which
passes only when the image built and passed the smoke test on both arches, or
the PR touched nothing the image uses). Dependabot's auto-merge waits on the
same three. A `refs/tags/v*` ruleset lets only admins create, move or delete a
release tag, since both publish workflows ship whatever a tag points at.
`scripts/setup-branch-protection.sh` applies all of this, and re-running it
converges; renaming any of those three jobs silently unrequires its check.

The repo is pre-1.0 with `bump-minor-pre-major: true`
(`release-please-config.json`), so a breaking change bumps minor, not major,
until the first 1.0.0 release:

- `fix:` bumps patch
- `feat:` bumps minor
- `feat!:` or a `BREAKING CHANGE:` footer bumps minor pre-1.0, major once the
  package reaches 1.0.0
- `chore:` / `docs:` / `refactor:` / `ci:` release nothing

## Pre-1.0

The Strava to intervals.icu migration is done and `0.2.0` already shipped it
(see `CHANGELOG.md`); every tool talks to intervals.icu directly. The package
is ready for its first stable release.

Cut `1.0.0` by forcing the version in config (see "Force a version" below):
add `"release-as": "1.0.0"` to the `.` package in `release-please-config.json`,
merge, and the open release PR retargets to `1.0.0`. Merge that PR, then
remove `release-as` in a follow-up so later releases bump normally.

After `1.0.0`, normal semver applies: `fix:` bumps patch, `feat:` bumps minor,
`feat!:`/a `BREAKING CHANGE:` footer bumps major. `bump-minor-pre-major` in
`release-please-config.json` stops mattering once the major version is
nonzero, so it does not need to change.

## What release-please does

It opens a `chore: release X.Y.Z` PR that bumps root `package.json`, the
top-level `server.json` version, and `CHANGELOG.md`. (The OCI package tag
inside `server.json` is NOT templated — release-please's json updater cannot
rewrite part of a string — so the in-repo identifier carries the placeholder
tag `stamped-at-publish`, and `publish-mcp.yml` stamps the real one from the
git tag at publish time. `serverJsonManifest.test.ts` pins the placeholder, so
a manual publish from a checkout fails the registry's pull instead of
registering a stale image.)

Merging that PR pushes the `vX.Y.Z` tag (via the `RELEASE_PLEASE_PAT` secret),
triggering:

- `docker.yml` → publishes `ghcr.io/ljcl/intervals-mcp:X.Y.Z`, `:X.Y` and
  `:latest`
- `publish-mcp.yml` → publishes `server.json` to the MCP registry via GitHub OIDC

`latest` moves only on a release tag push; a backfill dispatch of an old tag
never moves it. Main pushes that touch an image path (the `changes` filter in
`docker.yml`) publish `:edge` and `:main-<sha>` instead.

Commits touching only `docs/`, `.agents/`, or `.claude/` are excluded from
release parsing (`exclude-paths` in `release-please-config.json`), so a
mislabeled `fix:` on a planning doc cannot cut an empty release. A commit
touching excluded and non-excluded paths still counts.

Escapes:

- Force a version: set `"release-as": "X.Y.Z"` on the `.` package in
  `release-please-config.json` and merge; the release PR retargets on the next
  run. Remove it once that release ships, or every later release PR stays
  pinned to X.Y.Z. An empty commit with a `Release-As:` footer does NOT work
  here: release-please splits commits by path, and a commit that touches no
  files belongs to no path, so it is dropped before the footer is read
  (verified 2026-09-26).
- `release-please.yml` has a `workflow_dispatch` trigger for re-running after a
  transient failure without pushing anything.
- Manual `git tag vX.Y.Z` works as a fallback; both publish workflows trigger on
  `v*` tags regardless of how they were created.

## Image publishing and attestations

`docker.yml`'s build legs set `provenance: mode=max` and `sbom: true` on every
build that pushes (BuildKit's defaults are `mode=min` provenance and no SBOM);
PR builds push nothing and skip both. The merge job
adds a Sigstore-backed provenance attestation over the final index digest
(`actions/attest-build-provenance`, verifiable with `gh attestation verify`;
see [operations.md](operations.md#verifying-a-pulled-image)).

The merge **must** keep using `docker buildx imagetools create`: it copies each
source index's attestation manifests into the merged index, whereas
`docker manifest create` rejects a manifest-list source and would drop them.
The "Image summary" step filters `.platform.os != "unknown"` to skip those
attestation manifests when tallying per-arch sizes.

## MCP registry publishing

The registry proves image ownership by pulling the GHCR image and checking its
`io.modelcontextprotocol.server.name` label (set in `apps/server/Dockerfile`,
must match `name` in `server.json`). `publish-mcp.yml` therefore polls GHCR
until `docker.yml`'s manifest exists before publishing. That poll checks
**anonymous** visibility, because anonymous is how the registry's verifier
pulls: a package present but private fails immediately with a "make the package
public" message rather than burning the timeout.

The workflow's `validate` job stamps `server.json` the way a publish would and
runs `mcp-publisher validate`, which checks it against the live registry's
rules without logging in. It runs on every PR that touches `server.json`
(release-please's release PR included) and on every publish, and the `publish`
job publishes that validated file. `serverJsonManifest.test.ts` also pins the
Dockerfile label to `name`.

`mcp-publisher` is not version-pinned, because the registry rejects stale
publishers. The workflow takes the latest release and verifies its Sigstore
signature with `cosign verify-blob`, requiring the signer to be the registry
repo's `release.yml` at that release tag, before running it.

A failed publish is recoverable without a new release: run **Publish MCP
Registry** from the Actions tab (`workflow_dispatch`) with the existing
`vX.Y.Z` tag. It uses the workflow from `main` and the `server.json` from the
tag. The registry rejects a version that is already published, so this is for
a publish that failed, not for changing one that landed.

## Dependabot conventions

Dependabot uses `fix(deps):` for production npm deps and Docker base images
(they ship inside the published image, so a bump must cut a patch release to
reach users) and `chore(deps):` / `chore(ci):` for dev tooling and GitHub
Actions (no shipped artifact, no release). The npm groups are split by
dependency type so one grouped PR never mixes the two prefixes.

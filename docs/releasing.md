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

Cut `1.0.0` the same way as any forced version: land an empty commit on
`main` with a `Release-As: 1.0.0` footer
(`git commit --allow-empty -m "chore: force release" -m "Release-As: 1.0.0"`).
This is a controller ruling, not a config change; `release-as` is not added
to `release-please-config.json`. It retargets the open release-please PR to
`1.0.0`; merging that PR ships it through the normal path above.

After `1.0.0`, normal semver applies: `fix:` bumps patch, `feat:` bumps minor,
`feat!:`/a `BREAKING CHANGE:` footer bumps major. `bump-minor-pre-major` in
`release-please-config.json` stops mattering once the major version is
nonzero, so it does not need to change.

## What release-please does

It opens a `chore: release X.Y.Z` PR that bumps root `package.json`, the
top-level `server.json` version, and `CHANGELOG.md`. (The OCI package tag
inside `server.json` is NOT templated — `publish-mcp.yml` stamps it from the
git tag at publish time, since release-please's json updater cannot rewrite
part of a string.)

Merging that PR pushes the `vX.Y.Z` tag (via the `RELEASE_PLEASE_PAT` secret),
triggering:

- `docker.yml` → publishes `ghcr.io/ljcl/intervals-mcp:X.Y.Z` and `:X.Y`
- `publish-mcp.yml` → publishes `server.json` to the MCP registry via GitHub OIDC

Commits touching only `docs/`, `.agents/`, or `.claude/` are excluded from
release parsing (`exclude-paths` in `release-please-config.json`), so a
mislabeled `fix:` on a planning doc cannot cut an empty release. A commit
touching excluded and non-excluded paths still counts.

Escapes:

- Force a version: land an empty commit on `main` with a `Release-As` footer
  (`git commit --allow-empty -m "chore: force release" -m "Release-As: X.Y.Z"`);
  the release PR retargets on the next run.
- `release-please.yml` has a `workflow_dispatch` trigger for re-running after a
  transient failure or a Release-As commit without pushing anything.
- Manual `git tag vX.Y.Z` works as a fallback; both publish workflows trigger on
  `v*` tags regardless of how they were created.

## Image publishing and attestations

`docker.yml`'s build legs set `provenance: mode=max` and `sbom: true` —
BuildKit's defaults are `mode=min` provenance and no SBOM — and the merge job
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

## Dependabot conventions

Dependabot uses `fix(deps):` for production npm deps and Docker base images
(they ship inside the published image, so a bump must cut a patch release to
reach users) and `chore(deps):` / `chore(ci):` for dev tooling and GitHub
Actions (no shipped artifact, no release). The npm groups are split by
dependency type so one grouped PR never mixes the two prefixes.

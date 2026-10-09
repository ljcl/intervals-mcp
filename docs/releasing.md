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
GitHub takes each required check from the newest run on the PR's head commit,
so the three workflows never cancel a PR run: a stack push starts each upper
PR twice for one commit, and a cancelled newest run blocked the merge.

Normal semver applies (the package is past 1.0.0):

- `fix:` bumps patch; so do `perf:` and `revert:`, which also get changelog
  sections
- `feat:` bumps minor
- Any type with `!` (`feat!:`, `fix!:`, `refactor!:`) or a `BREAKING CHANGE:`
  footer bumps major. The type does not need to be releasable on its own:
  `refactor!:` cut 2.0.0.
- `chore:` / `docs:` / `refactor:` / `ci:` / `test:` / `build:` / `style:`
  without `!` release nothing

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

The build legs need Docker Hub images: the base images, the buildkit builder
and the SBOM scanner. During the 2.5.0 release Docker Hub failed the builds
with 429 (anonymous rate limit per runner IP), 500 and 504. So the legs pull
them through `mirror.gcr.io`, Google's public mirror of Docker Hub:
`setup-buildx-action` starts the builder from
`mirror.gcr.io/moby/buildkit` and gives BuildKit `mirror.gcr.io` as the
mirror for `docker.io`. The Dockerfile keeps its `docker.io` names, so
Dependabot, `dockerRuntime.test.ts` and local builds do not change, and the
digest pins make sure that the mirror serves the same content.

BuildKit falls back to Docker Hub when the mirror does not hold an image yet
(for example a digest that Dependabot has just bumped) or answers with an
error. For that fallback each leg logs in to Docker Hub first when the
repository has both of these:

- variable `DOCKERHUB_USERNAME`: the Docker Hub account name
- secret `DOCKERHUB_TOKEN`: a Docker Hub personal access token with
  **Public Repo Read-only** scope

Without them (fork PRs, or Dependabot PRs unless the token is also a
Dependabot secret), the leg writes a notice and pulls anonymously. A login
that fails (Docker Hub answered one with HTTP 500 during the 2.5.0 release)
does not fail the leg: the step is `continue-on-error`, so the leg pulls
anonymously.

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
repo's `release.yml` at that release tag, before running it. A "none of the
expected identities matched" failure after the registry reorganises its
release workflow means the identity in `publish-mcp.yml` needs updating, not
that the binary was tampered with; fix it and re-run the dispatch.

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

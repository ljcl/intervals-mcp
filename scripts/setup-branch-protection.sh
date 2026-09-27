#!/usr/bin/env bash
# Apply branch protection and repo settings for intervals-mcp: every setting
# docs/releasing.md, README.md and SECURITY.md say the repo has.
# Safe to re-run. Requires: gh authenticated with admin on the repo, repo already public,
# and the required checks below to have run at least once (so the status contexts exist).
set -euo pipefail

REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
echo "Configuring: ${REPO}"

# 1. Merge settings. Squash only, with the PR title as the commit subject:
#    release-please reads that subject, so a merge or rebase commit, or a
#    squash titled from the branch's commits, could skip a release silently
#    (docs/releasing.md). Auto-merge is what the Dependabot workflow uses.
gh api -X PATCH "repos/${REPO}" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true >/dev/null
echo "  - squash-only merges titled from the PR, auto-merge enabled"

# 2. Private vulnerability reporting, which SECURITY.md tells reporters to use.
gh api -X PUT "repos/${REPO}/private-vulnerability-reporting" >/dev/null
echo "  - private vulnerability reporting enabled"

# 3. Set GitHub Pages build source to GitHub Actions (idempotent; ignore if already set).
gh api -X POST "repos/${REPO}/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/${REPO}/pages" -f build_type=workflow >/dev/null 2>&1 \
  || echo "  - Pages: already configured or needs manual enable in Settings > Pages"

# 4. Branch protection on main.
#    - require these status checks to pass (strict / up to date):
#        check      ci.yml: lint, test, typecheck, build, boundaries
#        pr-title   pr-title.yml: a Conventional Commit title, or release-please
#                   skips the release without an error
#        docker-ok  docker.yml: the image builds and passes the smoke test on
#                   both arches (skipped legs on docs-only PRs count as passing)
#    - require a PR before merging, 0 approvals (solo maintainer can self-merge)
#    - block force pushes and deletions; require conversation resolution
gh api -X PUT "repos/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "pr-title", "docker-ok"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
echo "  - branch protection applied to main"

# Creates the named ruleset, or replaces it in place when one by that name
# exists, so a re-run converges instead of stacking duplicates.
upsert_ruleset() {
  local name="$1" body="$2" id
  id="$(gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name == \"${name}\") | .id")"
  if [ -n "$id" ]; then
    gh api -X PUT "repos/${REPO}/rulesets/${id}" --input - >/dev/null <<<"$body"
  else
    gh api -X POST "repos/${REPO}/rulesets" --input - >/dev/null <<<"$body"
  fi
}

# 5. Linear history on every branch (squash-only merges already produce it).
upsert_ruleset "Linear History" '{
  "name": "Linear History",
  "target": "branch",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["~ALL"], "exclude": []}},
  "rules": [{"type": "required_linear_history"}],
  "bypass_actors": []
}'
echo "  - linear history ruleset applied"

# 6. Release tags. docker.yml and publish-mcp.yml publish whatever a v* tag
#    points at, so only repository admins may create, move or delete one.
#    release-please pushes tags with RELEASE_PLEASE_PAT, an admin's token, so
#    releases still go through; a workflow's GITHUB_TOKEN or any other writer
#    cannot.
upsert_ruleset "Release tags" '{
  "name": "Release tags",
  "target": "tag",
  "enforcement": "active",
  "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
  "rules": [{"type": "creation"}, {"type": "update"}, {"type": "deletion"}],
  "bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]
}'
echo "  - release tag ruleset applied (admins only)"

echo "Done. Verify: gh api repos/${REPO}/branches/main/protection --jq '.required_status_checks'"

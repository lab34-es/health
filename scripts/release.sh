#!/usr/bin/env bash
#
# Publishes a new version of the package to npmjs.
#
#   ./scripts/release.sh patch|minor|major
#
# Environment overrides:
#   RELEASE_BRANCH  branch releases must be made from (default: master)
#   REMOTE          git remote to push to (default: origin)
#   SKIP_TESTS      set to 1 to skip "npm test" before publishing

set -euo pipefail

RELEASE_BRANCH="${RELEASE_BRANCH:-master}"
REMOTE="${REMOTE:-origin}"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\033[36m==>\033[0m %s\n' "$1"; }

BUMP="${1:-}"
case "$BUMP" in
  patch|minor|major) ;;
  "") die "missing version bump. Usage: $0 patch|minor|major" ;;
  *) die "invalid version bump '$BUMP'. Expected patch, minor or major" ;;
esac

cd "$(dirname "$0")/.."

# 1. Refuse to release from a dirty tree or from the wrong branch.
step "Checking the working tree and branch"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "$RELEASE_BRANCH" ] ||
  die "releases must be made from '$RELEASE_BRANCH', but you are on '$BRANCH'"

[ -z "$(git status --porcelain)" ] ||
  die "the working tree has uncommitted changes. Commit or stash them first:
$(git status --short)"

git fetch --quiet "$REMOTE" "$RELEASE_BRANCH" ||
  die "could not fetch '$RELEASE_BRANCH' from '$REMOTE'"

AHEAD="$(git rev-list --count "$REMOTE/$RELEASE_BRANCH..HEAD")"
BEHIND="$(git rev-list --count "HEAD..$REMOTE/$RELEASE_BRANCH")"
[ "$AHEAD" -eq 0 ] ||
  die "$AHEAD unpushed commit(s) on '$RELEASE_BRANCH'. Push them first"
[ "$BEHIND" -eq 0 ] ||
  die "'$RELEASE_BRANCH' is $BEHIND commit(s) behind '$REMOTE'. Pull first"

npm whoami >/dev/null 2>&1 ||
  die "you are not logged in to npmjs. Run 'npm login' first"

if [ "${SKIP_TESTS:-}" != "1" ]; then
  step "Running the test suite"
  npm test
fi

CURRENT="$(node -p "require('./package.json').version")"

# 2. Bump the version in package.json and commit it (npm also tags the commit).
step "Bumping the $BUMP version from $CURRENT"
npm version "$BUMP" --message "Release v%s" >/dev/null
NEXT="$(node -p "require('./package.json').version")"
printf '    %s -> %s\n' "$CURRENT" "$NEXT"

# 3. Push the release commit and its tag.
step "Pushing $RELEASE_BRANCH and v$NEXT to $REMOTE"
git push --follow-tags "$REMOTE" "$RELEASE_BRANCH"

# 4. Publish to npmjs ("prepublishOnly" rebuilds dist from scratch).
step "Publishing @lab34/health@$NEXT to npmjs"
npm publish --access public

printf '\033[32m✔\033[0m Published %s@%s\n' "$(node -p "require('./package.json').name")" "$NEXT"

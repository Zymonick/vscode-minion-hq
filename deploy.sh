#!/usr/bin/env bash
set -euo pipefail

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: minion-hq-deploy ["Commit message"]'
  echo 'Check, commit all changes, push the current branch to origin, and install Minion HQ.'
  exit 0
fi
if [[ $# -gt 1 || ${1:-} == -* ]]; then
  echo 'Usage: minion-hq-deploy ["Commit message"]' >&2
  exit 2
fi

# Resolve the installed symlink so the caller's working directory is irrelevant.
DEPLOY_ROOT=$(dirname "$(readlink -f -- "${BASH_SOURCE[0]}")")
cd "$DEPLOY_ROOT"
if [[ $(git rev-parse --show-toplevel) != "$DEPLOY_ROOT" ]]; then
  echo 'deploy.sh must be in the Minion HQ repository root.' >&2
  exit 1
fi
DEPLOY_BRANCH=$(git symbolic-ref --quiet --short HEAD) || {
  echo 'Checkout a branch before deploying Minion HQ.' >&2
  exit 1
}
git remote get-url origin >/dev/null
if [[ -n $(git ls-files --unmerged) ]]; then
  echo 'Resolve merge conflicts before deploying Minion HQ.' >&2
  exit 1
fi

DEPLOY_NODE_MAJOR=$(tr -d '[:space:]' < .nvmrc)
if [[ -z ${NODE_BIN:-} ]]; then
  NODE_BIN=$(command -v node || true)
  if [[ -z "$NODE_BIN" || $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') != "$DEPLOY_NODE_MAJOR" ]]; then
    NODE_BIN=''
    while IFS= read -r candidate; do
      [[ -x "$candidate" ]] && NODE_BIN="$candidate"
    done < <(printf '%s\n' "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$DEPLOY_NODE_MAJOR".*/bin/node | sort -V)
  fi
fi
if [[ -z "$NODE_BIN" || $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') != "$DEPLOY_NODE_MAJOR" ]]; then
  echo "Node.js $DEPLOY_NODE_MAJOR is required. Install it with nvm or set NODE_BIN." >&2
  exit 1
fi
export NODE_BIN

echo "Deploying Minion HQ from $DEPLOY_ROOT ($DEPLOY_BRANCH)"
./ci.sh
git add --all
if ! git diff --cached --quiet; then
  git commit -m "${1:-Update Minion HQ}"
fi
git push --set-upstream origin "HEAD:refs/heads/$DEPLOY_BRANCH"
./build.sh

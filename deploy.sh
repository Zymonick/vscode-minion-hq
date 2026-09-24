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
if [[ $(git rev-parse --path-format=absolute --git-common-dir) != "/home/azrael/vscode-minion-hq/.git" ]]; then
  echo 'Deployment is restricted to the Minion HQ repository and its worktrees.' >&2
  exit 1
fi
if [[ "$DEPLOY_BRANCH" == master || "$DEPLOY_BRANCH" == main ]]; then
  echo 'Deploy from a task branch, not master or main.' >&2
  exit 1
fi
DEPLOY_REMOTE='git@github.com:Zymonick/vscode-minion-hq.git'
if [[ $(git remote get-url --all origin) != "$DEPLOY_REMOTE" || $(git remote get-url --push --all origin) != "$DEPLOY_REMOTE" ]]; then
  echo 'Deployment requires only the pinned Minion HQ origin for fetch and push.' >&2
  exit 1
fi
python3 - <<'PYTHON'
import json
import re
import sys

with open('extension/package.json') as source:
    package = json.load(source)
if (package.get('publisher'), package.get('name')) != ('simon', 'scm-diff-stats'):
    sys.exit('Deployment can install only simon.scm-diff-stats.')
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', package.get('version', '')):
    sys.exit('Deployment requires a numeric Minion HQ release version.')
PYTHON
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

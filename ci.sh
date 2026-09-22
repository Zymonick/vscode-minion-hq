#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

NODE_BIN=${NODE_BIN:-node}
"$NODE_BIN" --check extension/extension.js
"$NODE_BIN" --test extension/tests/*.test.js
./build.sh --package-only

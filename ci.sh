#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

NODE_BIN=${NODE_BIN:-node}
"$NODE_BIN" --check extension/extension.js
"$NODE_BIN" --check terminal/hq.js
bash -n terminal/minion-hq
"$NODE_BIN" --test extension/tests/*.test.js terminal/tests/*.test.js
python3 -B -m unittest discover -s tests -p 'test_*.py'
./build.sh --package-only

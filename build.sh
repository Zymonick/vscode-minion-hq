#!/usr/bin/env bash
# Build the .vsix; --package-only skips local installation.
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  ''|--package-only) ;;
  *) echo "Usage: ./build.sh [--package-only]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "Usage: ./build.sh [--package-only]" >&2
  exit 2
fi

VERSION=$(python3 -c "import json; print(json.load(open('extension/package.json'))['version'])")
VSIX="minion-hq-$VERSION.vsix"

python3 - "$VSIX" <<'EOF'
import json, sys, zipfile
import xml.etree.ElementTree as ET

with open('extension/package.json') as f:
    package = json.load(f)
manifest = ET.parse('extension.vsixmanifest').getroot()
ns = {'v': 'http://schemas.microsoft.com/developer/vsx-schema/2011'}
identity = manifest.find('v:Metadata/v:Identity', ns)
for attr, key in [('Id', 'name'), ('Version', 'version'), ('Publisher', 'publisher')]:
    if identity.get(attr) != package[key]:
        sys.exit(f'Manifest {attr} does not match package.json {key}')
if manifest.findtext('v:Metadata/v:DisplayName', namespaces=ns) != package['displayName']:
    sys.exit('Manifest DisplayName does not match package.json displayName')

with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.write('extension.vsixmanifest')
    z.write('[Content_Types].xml')
    z.write('extension/package.json')
    z.write('extension/extension.js')
    z.write('extension/media/diff-stats.svg')
print(f'built {sys.argv[1]}')
EOF

if [ "${1:-}" = --package-only ]; then
  exit 0
fi

# The WSL-aware `code` launcher can establish the remote connection itself.
# The server-only CLI needs an existing VS Code terminal IPC hook, so keep it
# as a fallback instead of reporting a false success from headless shells.
CODE=$(command -v code || true)
CODE=${CODE:-$(ls -t "$HOME"/.vscode-server/bin/*/bin/remote-cli/code 2>/dev/null | head -1 || true)}
if [ -n "$CODE" ]; then
  "$CODE" --install-extension "$VSIX" --force
  SERVER_PACKAGE="$HOME/.vscode-server/extensions/simon.scm-diff-stats-$VERSION/package.json"
  LOCAL_PACKAGE="$HOME/.vscode/extensions/simon.scm-diff-stats-$VERSION/package.json"
  if [ ! -f "$SERVER_PACKAGE" ] && [ ! -f "$LOCAL_PACKAGE" ]; then
    echo "installer returned without installing Minion HQ $VERSION" >&2
    exit 1
  fi
  echo "installed Minion HQ $VERSION — reload the VS Code window to pick it up"
else
  echo "code CLI not found; install manually: code --install-extension $VSIX"
fi

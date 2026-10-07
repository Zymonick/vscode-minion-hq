"""Install Minion HQ into the default and existing Minion HQ profiles."""

import json
from pathlib import Path
import subprocess
import sys
import zipfile


EXTENSION_ID = 'simon.scm-diff-stats'


def read_json(path):
    return json.loads(path.read_text())


def registration(path):
    if not path.exists():
        return None
    entries = [entry for entry in read_json(path)
               if entry.get('identifier', {}).get('id') == EXTENSION_ID]
    if len(entries) > 1:
        raise RuntimeError(f'Duplicate Minion HQ registrations: {path}')
    return entries[0] if entries else None


def targets(home):
    server = home / '.vscode-server'
    if server.is_dir():
        extensions = server / 'extensions'
        user = server / 'data/User'
    else:
        extensions = home / '.vscode/extensions'
        user = home / '.config/Code/User'
    result = [(None, extensions / 'extensions.json')]
    metadata = user / 'globalStorage/storage.json'
    profiles = read_json(metadata).get('userDataProfiles', []) if metadata.exists() else []
    names = {profile['location']: profile['name'] for profile in profiles}
    for registry in sorted((user / 'profiles').glob('*/extensions.json')):
        if not registration(registry):
            continue
        name = names.get(registry.parent.name)
        if not isinstance(name, str) or not name.strip():
            raise RuntimeError(f'Cannot resolve the VS Code profile name for {registry}')
        result.append((name, registry))
    return extensions, result


def verify(registry, extensions, package, version):
    entry = registration(registry)
    if not entry or entry.get('version') != version:
        raise RuntimeError(f'Installed Minion HQ {version} is not registered in {registry}')
    installed = Path(entry['location']['path']).resolve()
    if installed.parent != extensions.resolve():
        raise RuntimeError(f'Unexpected Minion HQ installation path: {installed}')
    for item in package.infolist():
        if not item.filename.startswith('extension/') or item.is_dir():
            continue
        relative = item.filename.removeprefix('extension/')
        expected = package.read(item)
        actual = (installed / relative).read_bytes()
        if relative == 'package.json':
            actual = json.loads(actual)
            actual.pop('__metadata', None)  # VS Code adds installation metadata.
            matches = actual == json.loads(expected)
        else:
            matches = actual == expected
        if not matches:
            raise RuntimeError(f'Installed file differs from the tested package: {installed / relative}')


def install(code, vsix, home):
    extensions, profiles = targets(home)
    with zipfile.ZipFile(vsix) as package:
        manifest = json.loads(package.read('extension/package.json'))
        if manifest['publisher'] + '.' + manifest['name'] != EXTENSION_ID:
            raise RuntimeError('Only the Minion HQ extension can be installed')
        version = manifest['version']
        for name, registry in profiles:
            command = [str(code), '--install-extension', str(vsix.resolve()), '--force']
            if name is not None:
                command.extend(['--profile', name])
            subprocess.run(command, check=True)
            verify(registry, extensions, package, version)
            print(f'Verified Minion HQ {version} in profile {name or "Default"}', flush=True)
    print('Reload the VS Code window to activate Minion HQ.', flush=True)


if __name__ == '__main__':
    try:
        install(sys.argv[1], Path(sys.argv[2]), Path.home())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))

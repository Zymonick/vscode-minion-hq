"""Install Minion HQ into the default and existing Minion HQ profiles."""

import json
import os
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


def window_installers(home):
    """Use the live window CLI: the headless WSL launcher drops --profile."""
    clis = sorted((home / '.vscode-server/bin').glob('*/bin/remote-cli/code'),
                  key=lambda path: path.stat().st_mtime, reverse=True)
    if not clis:
        raise RuntimeError('Cannot find the VS Code remote CLI')
    runtime = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'))
    hooks = sorted(runtime.glob('vscode-ipc-*.sock'), key=lambda path: path.stat().st_mtime, reverse=True)
    result = []
    for hook in hooks:
        if not hook.is_socket():
            continue
        env = {**os.environ, 'VSCODE_IPC_HOOK_CLI': str(hook)}
        env.pop('VSCODE_CLIENT_COMMAND', None)
        try:
            probe = subprocess.run([str(clis[0]), '--list-extensions', '--show-versions'],
                                   env=env, capture_output=True, text=True, timeout=5, check=True)
        except (OSError, subprocess.SubprocessError):
            continue
        if any(line.strip().startswith(EXTENSION_ID + '@') for line in probe.stdout.splitlines()):
            result.append((str(clis[0]), env))
    return result


def install(code, vsix, home):
    extensions, profiles = targets(home)
    with zipfile.ZipFile(vsix) as package:
        manifest = json.loads(package.read('extension/package.json'))
        if manifest['publisher'] + '.' + manifest['name'] != EXTENSION_ID:
            raise RuntimeError('Only the Minion HQ extension can be installed')
        version = manifest['version']
        # The headless launcher installs Default. Named WSL profiles must use
        # their running window's CLI connection; --profile is silently ignored.
        subprocess.run([str(code), '--install-extension', str(vsix.resolve()), '--force'], check=True)
        if len(profiles) > 1 and extensions.parent.name == '.vscode-server':
            installers = window_installers(home)
            if not installers:
                raise RuntimeError('Open the VS Code profiles that use Minion HQ, then retry deployment')
            for remote_cli, env in installers:
                if all((registration(registry) or {}).get('version') == version for _, registry in profiles[1:]):
                    break
                subprocess.run([remote_cli, '--install-extension', str(vsix.resolve()), '--force'],
                               env=env, check=True, timeout=60)
        elif len(profiles) > 1:
            for name, _ in profiles[1:]:
                subprocess.run([str(code), '--install-extension', str(vsix.resolve()), '--force',
                                '--profile', name], check=True)
        for name, registry in profiles:
            verify(registry, extensions, package, version)
            print(f'Verified Minion HQ {version} in profile {name or "Default"}', flush=True)
    print('Reload the VS Code window to activate Minion HQ.', flush=True)


if __name__ == '__main__':
    try:
        install(sys.argv[1], Path(sys.argv[2]), Path.home())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        sys.exit(str(error))

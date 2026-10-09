import contextlib
import io
import json
import os
import socket
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

import install


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='minion-install-')
        self.addCleanup(self.scratch.cleanup)
        self.home = Path(self.scratch.name)
        self.extensions = self.home / '.vscode-server/extensions'
        self.user = self.home / '.vscode-server/data/User'
        self.profiles = {None: self.extensions / 'extensions.json'}
        self.calls = []
        self.windows = [('/fake/remote-code', {'MINION_TEST_PROFILE': 'Minion profile with spaces'})]
        self.version = '0.13.18'
        self.vsix = self.home / 'release with spaces.vsix'
        self.manifest = {'publisher': 'simon', 'name': 'scm-diff-stats', 'version': self.version}
        with zipfile.ZipFile(self.vsix, 'w') as package:
            package.writestr('extension/package.json', json.dumps(self.manifest))
            package.writestr('extension/extension.js', 'tested code\n')
        self.write_registration(self.profiles[None], '0.13.16')

    def write_registration(self, registry, version):
        registry.parent.mkdir(parents=True, exist_ok=True)
        directory = self.extensions / ('simon.scm-diff-stats-' + version)
        registry.write_text(json.dumps([{
            'identifier': {'id': 'simon.scm-diff-stats'}, 'version': version,
            'location': {'path': str(directory)},
        }]))

    def add_profile(self, name='Minion profile with spaces', identifier='abc'):
        registry = self.user / 'profiles' / identifier / 'extensions.json'
        self.profiles[name] = registry
        self.write_registration(registry, '0.13.16')
        metadata = self.user / 'globalStorage/storage.json'
        metadata.parent.mkdir(parents=True, exist_ok=True)
        metadata.write_text(json.dumps({'userDataProfiles': [{'location': identifier, 'name': name}]}))
        return registry

    def fake_cli(self, command, check, env=None, timeout=None):
        self.assertTrue(check)
        self.assertIn(command[0], ['/fake/code with spaces', '/fake/remote-code'])
        self.assertEqual(command[1:4], ['--install-extension', str(self.vsix), '--force'])
        name = (env or {}).get('MINION_TEST_PROFILE') or (command[5] if len(command) > 4 else None)
        if name and env is None:
            self.assertEqual(command[4], '--profile')
        self.calls.append(name)
        self.write_registration(self.profiles[name], self.version)
        installed = self.extensions / ('simon.scm-diff-stats-' + self.version)
        installed.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(self.vsix) as package:
            for item in package.infolist():
                (installed / item.filename[len('extension/'):]).write_bytes(package.read(item))
        manifest = {**self.manifest, '__metadata': {'installedTimestamp': 1234}}
        (installed / 'package.json').write_text(json.dumps(manifest))

    def run_install(self, cli=None):
        with mock.patch.object(install, 'window_installers', return_value=self.windows), \
                mock.patch.object(install.subprocess, 'run', side_effect=cli or self.fake_cli), \
                contextlib.redirect_stdout(io.StringIO()):
            install.install('/fake/code with spaces', self.vsix, self.home)

    def test_updates_default_and_existing_profiles_without_adding_to_unrelated_profiles(self):
        self.add_profile()
        self.windows = self.windows * 2  # Two CLI connections may belong to one window.
        unrelated = self.user / 'profiles/unrelated/extensions.json'
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text('[]')
        self.run_install()
        self.assertEqual(self.calls, [None, 'Minion profile with spaces'])
        self.assertEqual(unrelated.read_text(), '[]')
        for registry in self.profiles.values():
            self.assertEqual(install.registration(registry)['version'], self.version)

    def test_successful_cli_cannot_hide_a_stale_named_profile(self):
        self.add_profile()

        def cli(command, check, **kwargs):
            if command[0] != '/fake/remote-code':
                self.fake_cli(command, check)

        with self.assertRaisesRegex(RuntimeError, 'not registered.*profiles/abc'):
            self.run_install(cli)

    def test_existing_version_directory_does_not_prove_registration(self):
        self.fake_cli(['/fake/code with spaces', '--install-extension', str(self.vsix), '--force'], True)
        self.write_registration(self.profiles[None], '0.13.16')
        with self.assertRaisesRegex(RuntimeError, 'not registered'):
            self.run_install(lambda *args, **kwargs: None)

    def test_installed_code_must_match_tested_package(self):
        def cli(command, check):
            self.fake_cli(command, check)
            (self.extensions / ('simon.scm-diff-stats-' + self.version) / 'extension.js').write_text('old code')

        with self.assertRaisesRegex(RuntimeError, 'Installed file differs'):
            self.run_install(cli)

    def test_missing_profile_name_fails_before_any_install(self):
        self.add_profile()
        (self.user / 'globalStorage/storage.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'Cannot resolve.*profile name'):
            self.run_install()
        self.assertEqual(self.calls, [])

    def test_failed_cli_stops_installation(self):
        self.add_profile()

        def cli(command, check):
            self.calls.append(command)
            raise subprocess.CalledProcessError(7, command)

        with self.assertRaises(subprocess.CalledProcessError):
            self.run_install(cli)
        self.assertEqual(len(self.calls), 1)

    def test_local_host_profiles_are_used_without_a_vscode_server(self):
        server = self.home / '.vscode-server'
        server.rename(self.home / 'unused-server-fixture')
        self.extensions = self.home / '.vscode/extensions'
        self.user = self.home / '.config/Code/User'
        self.profiles = {None: self.extensions / 'extensions.json'}
        self.add_profile()
        self.run_install()
        self.assertEqual(self.calls, [None, 'Minion profile with spaces'])


    def test_named_wsl_profile_without_live_window_fails(self):
        self.add_profile()
        self.windows = []
        with self.assertRaisesRegex(RuntimeError, 'Open the VS Code profiles'):
            self.run_install()
        self.assertEqual(install.registration(self.profiles['Minion profile with spaces'])['version'], '0.13.16')

    def test_only_live_windows_already_using_minion_are_install_targets(self):
        cli = self.home / '.vscode-server/bin/commit/bin/remote-cli/code'
        cli.parent.mkdir(parents=True)
        cli.write_text('fixture')
        runtime = self.home / 'runtime'
        runtime.mkdir()
        for name in ['minion', 'other', 'stale']:
            sock = socket.socket(socket.AF_UNIX)
            self.addCleanup(sock.close)
            sock.bind(str(runtime / ('vscode-ipc-' + name + '.sock')))

        def probe(command, **kwargs):
            self.assertEqual(command, [str(cli), '--list-extensions', '--show-versions'])
            self.assertNotIn('VSCODE_CLIENT_COMMAND', kwargs['env'])
            hook = kwargs['env']['VSCODE_IPC_HOOK_CLI']
            if 'stale' in hook:
                raise subprocess.TimeoutExpired(command, 5)
            output = 'simon.scm-diff-stats@0.13.16\n' if 'minion.sock' in hook else 'other.extension@1.0.0\n'
            return subprocess.CompletedProcess(command, 0, output)

        with mock.patch.dict(os.environ, {'XDG_RUNTIME_DIR': str(runtime), 'VSCODE_CLIENT_COMMAND': 'headless-launcher'}), \
                mock.patch.object(install.subprocess, 'run', side_effect=probe):
            result = install.window_installers(self.home)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0][0], str(cli))
        self.assertTrue(result[0][1]['VSCODE_IPC_HOOK_CLI'].endswith('vscode-ipc-minion.sock'))

    def test_another_extension_is_refused_before_installation(self):
        with zipfile.ZipFile(self.vsix, 'w') as package:
            package.writestr('extension/package.json', json.dumps({**self.manifest, 'publisher': 'other'}))
        with self.assertRaisesRegex(RuntimeError, 'Only the Minion HQ extension'):
            self.run_install()
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

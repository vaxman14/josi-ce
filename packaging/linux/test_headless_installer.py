import importlib.util
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = Path(__file__).with_name('install-josi-ce-server.sh')
SAMPLE = {
    'arch-x86_64': ('josi-1.1.0-1-x86_64.pkg.tar.zst', 'a' * 64),
    'debian-x86_64': ('josi_1.1.0_amd64.deb', 'b' * 64),
}


def load_generator():
    sys.path.insert(0, str(REPO / 'scripts/linux'))
    spec = importlib.util.spec_from_file_location('build_headless_installer', REPO / 'scripts/linux/build-headless-installer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TEXT = load_generator().render('1.1.0', 'https://github.com/vaxman14/josi-ce/releases/download/v1.1.0', SAMPLE)


class HeadlessInstallerTests(unittest.TestCase):
    @unittest.skipUnless(Path('/bin/bash').exists(), 'bash required')
    def test_bash_syntax(self):
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as rendered:
            rendered.write(TEXT)
        subprocess.run(['/bin/bash', '-n', rendered.name], check=True)
        subprocess.run(['/bin/bash', '-n', str(TEMPLATE)], check=True)

    def test_release_packages_and_hashes_are_pinned(self):
        self.assertIn('VERSION=1.1.0\n', TEXT)
        self.assertIn('BASE_URL=https://github.com/vaxman14/josi-ce/releases/download/v1.1.0\n', TEXT)
        for key, (package, digest) in SAMPLE.items():
            family, processor = key.split('-')
            self.assertIn(f'{family} {processor} {package} {digest}', TEXT)
        self.assertIsNone(re.search(r'@[A-Z_]+@', TEXT))

    def test_template_placeholders_are_all_filled_or_refused(self):
        generator = load_generator()
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {**SAMPLE, 'debian-x86_64': ('bad name', 'c' * 64)})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {**SAMPLE, 'arch-x86_64': (SAMPLE['arch-x86_64'][0], 'short')})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', 'https://example.invalid', {'rpm-x86_64': ('josi.rpm', 'c' * 64)})
        with self.assertRaises(ValueError):
            generator.render('1.1.0', "https://example.invalid/'; rm -rf /", SAMPLE)

    def test_one_root_command_and_one_line_of_output(self):
        self.assertIn('[ "$(id -u)" = 0 ]', TEXT)
        self.assertEqual(TEXT.count('/usr/bin/josi-ce-server-install'), 1)
        # stdout gets the address and nothing else; the progress screen is on stderr.
        self.assertEqual(len(re.findall(r"^\s*printf '%s\\n' \"\$url\"$", TEXT, re.M)), 1)
        self.assertEqual(len(re.findall(r"^\s*printf '  %s%s%s\\n' \"\$BOLD\$GOLD\" \"\$url\" \"\$RST\"$", TEXT, re.M)), 1)
        for line in TEXT.splitlines():
            if re.match(r'^\s*printf ', line) and '$url' not in line and 'printf -v' not in line and ' | ' not in line:
                # stderr, the log, or the terminal itself (fd 5, the questions).
                self.assertTrue('>&2' in line or '>&3' in line or '>&5' in line or line.rstrip().endswith('\\'), line)
        # The questions read and write the terminal, never stdin or stdout.
        self.assertIn('read -e -r -i "$shown" -p "$prompt" REPLY <&5 >&5 2>&5', TEXT)
        self.assertIn('exec 5<>/dev/tty', TEXT)
        self.assertNotIn('sudo ', TEXT.replace('| sudo bash', ''))
        self.assertNotIn('git ', TEXT)
        self.assertNotIn('docker', TEXT.lower())

    def test_checksum_is_verified_before_the_package_manager_runs(self):
        verify = TEXT.index('[ "$actual" = "$expected" ]')
        self.assertLess(verify, TEXT.index('pacman -U'))
        self.assertLess(verify, TEXT.index('apt_get install -y -q "$work/$package"'))

    def test_detects_both_families_and_processors(self):
        for text in ('command -v pacman', 'command -v apt-get', 'aarch64|arm64) processor=aarch64', 'x86_64|amd64) processor=x86_64'):
            self.assertIn(text, TEXT)

    def test_interruptions_do_not_wedge_the_install(self):
        # A dropped SSH session is ignored (and inherited by dpkg and the
        # lifecycle); dpkg's unfinished work is completed before apt runs.
        self.assertIn("trap '' HUP", TEXT)
        self.assertNotIn("INT TERM HUP", TEXT)
        self.assertLess(TEXT.index('run dpkg --configure -a'), TEXT.index('apt-get update'))
        self.assertLess(TEXT.index("trap '' HUP"), TEXT.index('begin 1'))

    def test_every_apt_get_waits_for_the_lock(self):
        self.assertIn("APT_LOCK='DPkg::Lock::Timeout=600'", TEXT)
        for line in TEXT.splitlines():
            code = line.split('#', 1)[0]
            if re.search(r'\bapt-get\b', code) and 'command -v' not in code:
                self.assertIn('-o "$APT_LOCK"', code, line)

    def test_root_without_sudo_is_explained_and_allowed(self):
        self.assertIn('wget -qO- <address>/linux | bash', TEXT)
        self.assertIn('wget -qO- https://<install host>/linux | bash', TEXT)
        # curl itself is installed by the dependency step before any download.
        self.assertLess(TEXT.index('ca-certificates curl'), TEXT.index('curl -fsIL'))

    def test_pre_rename_layout_is_refused_with_the_purge_steps(self):
        self.assertIn('[ -d /var/lib/josi-ce-server ] && [ ! -e /var/lib/josi/installation.json ]', TEXT)
        self.assertIn('rm -rf /var/lib/josi-ce-server', TEXT)


@unittest.skipUnless(Path('/bin/bash').exists(), 'bash required')
class InstallerQuestionsTests(unittest.TestCase):
    """The installer's functions, run without main."""

    def shell(self, script, env=None):
        library = TEXT.rsplit('main "$@"', 1)[0]
        with tempfile.NamedTemporaryFile('w', suffix='.sh', delete=False) as handle:
            handle.write(library)
        result = subprocess.run(['/bin/bash', '-c', f'source {handle.name}; set +e; {script}'], capture_output=True, text=True,
            env={'PATH': '/usr/bin:/bin', **(env or {})}, stdin=subprocess.DEVNULL)
        Path(handle.name).unlink()
        return result

    def test_flags_pass_through_to_the_install_command(self):
        result = self.shell('parse_args --address-mode=domain --domain josi.example.com --email me@example.com '
            '--port 9443 --no-pc-control --yes; printf "%s|" "${CLI_ARGS[@]}"; printf "\\n%s %s" "$YES" "$GIVEN"')
        self.assertEqual(result.returncode, 0, result.stderr)
        args, state = result.stdout.split('\n')
        self.assertEqual(args, '--address-mode|domain|--domain|josi.example.com|--email|me@example.com|--port|9443|--no-pc-control|')
        self.assertEqual(state, '1  mode port pc ')

    def test_browser_flags_and_default(self):
        result = self.shell('parse_args --pc-control-user roman --no-browser; questions; printf "%s|%s" "$A_BROWSER" "${CLI_ARGS[*]}"')
        self.assertEqual(result.stdout, '0|--pc-control-user roman --no-browser')
        result = self.shell('S_PC=roman; questions; printf %s "$A_BROWSER"')
        self.assertEqual(result.stdout, '1')
        result = self.shell('S_PC=roman S_BROWSER=0; questions; printf %s "$A_BROWSER"')
        self.assertEqual(result.stdout, '0')

    @unittest.skipUnless(Path('/usr/bin/apt-cache').exists(), 'apt required')
    def test_browser_packages_pick_names_this_release_has(self):
        result = self.shell('exec 3>/dev/null; browser_packages; printf %s "$REPLY"')
        names = result.stdout.split()
        self.assertIn('xvfb', names)
        self.assertTrue({'libasound2', 'libasound2t64'} & set(names), names)
        self.assertFalse({'libasound2', 'libasound2t64'} <= set(names), names)

    def test_unknown_flag_and_missing_value_are_refused(self):
        self.assertEqual(self.shell('parse_args --bogus').returncode, 2)
        self.assertEqual(self.shell('parse_args --port').returncode, 2)

    def test_josi_yes_means_no_questions(self):
        result = self.shell('parse_args; printf %s "$YES"', {'JOSI_YES': '1'})
        self.assertEqual(result.stdout, '1')

    def test_no_terminal_uses_flags_saved_answers_and_defaults(self):
        result = self.shell('YES=0; open_tty; LAN_IP=10.1.2.3; parse_args --port 9000; questions; '
            'printf "%s|%s|%s|%s|%s" "$TTY" "$A_MODE" "$A_LAN" "$A_PORT" "$A_NOPC"; printf "|%s" "${CLI_ARGS[@]}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '0|lan|10.1.2.3|9000|1|--port|9000')

    def test_answer_checks(self):
        result = self.shell('for v in josi.example.com 10.0.0.5 "a b" bad..name; do valid_domain "$v" && printf "d:%s " "$v"; '
            'valid_host "$v" && printf "h:%s " "$v"; done; valid_email me@example.com && printf ok; '
            'valid_email nope || printf " no"; real_user root || printf " root-refused"')
        self.assertEqual(result.stdout, 'd:josi.example.com h:josi.example.com h:10.0.0.5 ok no root-refused')

    def test_port_busy_sees_a_listener(self):
        import socket
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen(1)
        self.addCleanup(listener.close)
        port = listener.getsockname()[1]
        result = self.shell(f'port_busy {port} && printf busy; free_port_after {port}; printf " %s" "$REPLY"')
        self.assertTrue(result.stdout.startswith('busy '), result.stdout + result.stderr)
        self.assertNotEqual(int(result.stdout.split()[1]), port)


if __name__ == '__main__':
    unittest.main()

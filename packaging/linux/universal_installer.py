#!/usr/bin/env python3
"""One-file GTK installer that selects the native package for this distro."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import threading
import urllib.request
import webbrowser

import gi
gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk

from universal_installer_core import (
    architecture, distro_family, load_manifest, package_url, read_os_release, sha256,
)


APPDIR = Path(os.environ.get('APPDIR', Path(__file__).resolve().parent))
MANIFEST = APPDIR / 'usr/share/josi-ce-server-installer/installer-manifest.json'
STATE = Path.home() / '.cache/josi-ce-server-installer'
URL_PATTERN = re.compile(r'^https?://[^\s]+$')


class Installer(Gtk.Application):
    def __init__(self):
        super().__init__(application_id='com.heyjosi.ce.server.installer')
        self.manifest = load_manifest(MANIFEST)
        self.os_release = read_os_release()
        self.family = distro_family(self.os_release)
        architecture(platform.machine())
        self.package = self.manifest['packages'][self.family]
        self.cached = STATE / self.manifest['version'] / self.package['name']
        self.busy = False
        self.ready = False
        self.final_url = None

    def do_activate(self):
        window = Gtk.ApplicationWindow(application=self, title='Josi CE Server Setup',
            default_width=700, default_height=420)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=16,
            margin_top=28, margin_bottom=28, margin_start=28, margin_end=28)
        title = Gtk.Label(label='Install Josi CE Server', xalign=0)
        title.add_css_class('title-1')
        box.append(title)
        pretty = self.os_release.get('PRETTY_NAME', self.os_release.get('NAME', 'Linux'))
        self.detail = Gtk.Label(label=f'Detected {pretty} · selecting the {self.family} package automatically',
            xalign=0, wrap=True)
        box.append(self.detail)
        copy = Gtk.Label(label='Josi will download and verify the correct package, request administrator approval, install its protected services, and open browser setup when ready. Existing Josi data is preserved.',
            xalign=0, wrap=True)
        box.append(copy)
        self.phase = Gtk.Label(label='Preparing installer…', xalign=0, wrap=True)
        box.append(self.phase)
        self.progress = Gtk.ProgressBar(show_text=True)
        box.append(self.progress)
        buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.install = Gtk.Button(label='Install Josi CE Server…')
        self.install.set_sensitive(False)
        self.install.connect('clicked', self.start_install)
        self.open = Gtk.Button(label='Open Josi')
        self.open.set_sensitive(False)
        self.open.connect('clicked', self.open_josi)
        buttons.append(self.install)
        buttons.append(self.open)
        box.append(buttons)
        self.log = Gtk.Label(xalign=0, wrap=True, selectable=True)
        box.append(self.log)
        window.set_child(box)
        window.connect('close-request', lambda *_: self.busy)
        window.present()
        if os.environ.get('JOSI_INSTALLER_SMOKE_TEST') == '1':
            self.phase.set_text('Portable GTK interface loaded successfully.')
            GLib.timeout_add(750, self.smoke_test_complete, window)
            return
        threading.Thread(target=self.prepare, daemon=True).start()

    def smoke_test_complete(self, window):
        window.destroy()
        self.quit()
        return False

    def ui(self, function, *args):
        GLib.idle_add(function, *args)

    def set_phase(self, text):
        self.ui(self.phase.set_text, text)

    def prepare(self):
        try:
            self.cached.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if self.cached.exists() and sha256(self.cached) == self.package['sha256']:
                self.prepared()
                return
            temporary = self.cached.with_suffix(self.cached.suffix + '.part')
            temporary.unlink(missing_ok=True)
            self.set_phase(f"Downloading {self.package['name']}…")
            request = urllib.request.Request(package_url(self.manifest, self.family),
                headers={'User-Agent': 'Josi-CE-Server-Installer/' + self.manifest['version']})
            with urllib.request.urlopen(request, timeout=30) as response, temporary.open('wb') as output:
                expected = int(response.headers.get('Content-Length', '0'))
                received = 0
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
                    received += len(block)
                    if expected:
                        fraction = min(received / expected, 1.0)
                        self.ui(self.progress.set_fraction, fraction)
                        self.ui(self.progress.set_text, f'{received // 1048576} / {expected // 1048576} MB')
                output.flush()
                os.fsync(output.fileno())
            self.set_phase('Verifying pinned release checksum…')
            if sha256(temporary) != self.package['sha256']:
                temporary.unlink(missing_ok=True)
                raise ValueError('Downloaded package checksum did not match')
            temporary.replace(self.cached)
            self.prepared()
        except Exception as error:
            self.ui(self.failed, f'Preparation failed: {error}')

    def prepared(self):
        self.ready = True
        self.ui(self.progress.set_fraction, 1.0)
        self.ui(self.progress.set_text, 'Verified')
        self.set_phase('The correct package is verified and ready to install.')
        self.ui(self.install.set_sensitive, True)

    def start_install(self, *_):
        if self.busy or not self.ready:
            return
        self.busy = True
        self.install.set_sensitive(False)
        self.progress.pulse()
        self.phase.set_text('Waiting for administrator approval…')
        threading.Thread(target=self.run_install, daemon=True).start()

    def run_command(self, command):
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True,
            env={**os.environ, 'LANG':'C.UTF-8', 'LC_ALL':'C.UTF-8'})
        for line in process.stdout:
            clean = line.strip()
            if not clean:
                continue
            if URL_PATTERN.fullmatch(clean):
                self.final_url = clean
            try:
                event = json.loads(clean)
                status = ' · '.join(str(event[key]) for key in ('phase', 'service') if event.get(key))
                if status:
                    self.set_phase(status)
            except (json.JSONDecodeError, TypeError):
                self.set_phase(clean[:240])
        return process.wait()

    def run_install(self):
        try:
            helper = APPDIR / 'usr/share/josi-ce-server-installer/universal_root_install.sh'
            command = ['pkexec', '/bin/sh', str(helper), self.family, str(self.cached),
                str(os.getuid()), self.package['sha256']]
            if self.run_command(command) != 0:
                raise RuntimeError('Installation was cancelled or failed; recovery evidence was preserved')
            if not self.final_url:
                raise RuntimeError('Josi installed, but its browser setup URL was unavailable')
            self.ui(self.succeeded)
        except Exception as error:
            self.ui(self.failed, str(error))

    def succeeded(self):
        self.busy = False
        self.progress.set_fraction(1.0)
        self.progress.set_text('Installed')
        self.phase.set_text('Josi CE Server is ready. Opening browser setup…')
        self.open.set_sensitive(True)
        self.open_josi()
        return False

    def failed(self, message):
        self.busy = False
        self.progress.set_text('Stopped')
        self.phase.set_text(message)
        self.log.set_text('Nothing was silently deleted. Correct the problem and retry this installer.')
        self.install.set_sensitive(self.ready)
        return False

    def open_josi(self, *_):
        if self.final_url:
            webbrowser.open(self.final_url, new=2)
            self.phase.set_text('Browser opened. Complete Josi setup there.')


def main():
    try:
        if sys.argv[1:] == ['--diagnose']:
            manifest = load_manifest(MANIFEST)
            values = read_os_release()
            family = distro_family(values)
            print(json.dumps({
                'architecture': architecture(platform.machine()),
                'distribution': values.get('PRETTY_NAME', values.get('ID', 'Linux')),
                'family': family,
                'package': manifest['packages'][family]['name'],
                'source': package_url(manifest, family),
                'version': manifest['version'],
            }, sort_keys=True))
            return 0
        return Installer().run(sys.argv)
    except Exception as error:
        print(f'Josi installer: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

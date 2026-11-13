#!/usr/bin/env python3
"""Josi's data in a NEW container: put back what lived in the old one.

A Josi container keeps its data in volumes, but two things an install makes
live in the container itself and are gone when the container is replaced (an
upgrade to a new image, or the same image started again with other options):

  - the service accounts (josi-ce-web and the rest) in /etc/passwd, and
  - the systemd units in /etc/systemd/system.

The installer rightly refuses to carry on over data whose accounts or units
it cannot find. This puts both back exactly as they were, from what the data
volume itself records, and then the ordinary installer upgrades or starts
Josi as on any machine:

  - accounts get the SAME numeric ids as before (/var/lib/josi/identities.json),
    so every file in the volume still belongs to the right service;
  - the shared groups get the ids their folders in the volume already carry;
  - the units are written for the version the data was last run with, by the
    installer's own generator, so its ownership check recognises them;
  - the stale lock the old container left on Josi's Chrome profile is removed.

It only acts on a pristine container: if any Josi account or unit is already
there it changes nothing (all present: this is the same container starting
again; some present: something else is going on, and it says so).
Run as root inside the container. josi-firstboot runs it at every start.
"""
import grp, json, os, pwd, subprocess, sys
from pathlib import Path

# The installer's code is imported from the program folder, and that folder is
# checked file by file before every install. Python must not leave a compiled
# copy in it.
sys.dont_write_bytecode = True

ROOT = Path('/var/lib/josi')
RUNTIME = Path('/usr/lib/josi/runtime')


def say(text):
    print('josi-adopt: ' + text, flush=True)


def run(*args):
    subprocess.run(list(args), check=True, capture_output=True, timeout=120)


def exists(lookup, key):
    try:
        lookup(key)
        return True
    except KeyError:
        return False


def main():
    if os.geteuid() != 0:
        say('run as root'); return 2
    receipt, identities_path, config_path = ROOT / 'installation.json', ROOT / 'identities.json', ROOT / 'data/config/runtime.json'
    if not (receipt.is_file() and identities_path.is_file() and config_path.is_file()):
        return 0  # No Josi data here: a first start. Nothing to do.
    if json.loads(receipt.read_text()).get('product') != 'Josi CE Server':
        say('the data volume is not a Josi server; nothing changed'); return 1
    sys.path.insert(0, str(RUNTIME / 'app/native'))
    import lifecycle as L

    units = {role: L.UNIT_DIR / (L.UNIT_PREFIX + role + '.service') for role in L.ROLES}
    accounts = [exists(pwd.getpwnam, name) for name in L.ACCOUNTS.values()]
    present = accounts + [path.exists() for path in units.values()]
    if all(present):
        return 0  # The same container starting again.
    if any(present):
        say('some of Josi\'s service accounts or units exist and some do not; nothing changed'); return 1

    identities = json.loads(identities_path.read_text())
    version = json.loads(config_path.read_text())['version']
    program = ROOT / 'versions' / version
    if not (program / 'app/package.json').is_file():
        say(f'the program for the version the data was last run with ({version}) is missing; nothing changed'); return 1

    # Checked before anything is made, so a clash leaves the container untouched.
    for role, name in L.ACCOUNTS.items():
        uid, gid = identities[role]
        if exists(pwd.getpwuid, uid) or exists(grp.getgrgid, gid) or exists(grp.getgrnam, name):
            say(f'the id recorded for {name} ({uid}:{gid}) is taken in this container; nothing changed'); return 1

    say(f'data from Josi {version} found in a new container: restoring its service accounts and units')
    for role, name in L.ACCOUNTS.items():
        uid, gid = identities[role]
        run('/usr/sbin/groupadd', '--system', '--gid', str(gid), name)
        run('/usr/sbin/useradd', '--system', '--uid', str(uid), '--gid', name, '--home-dir', str(ROOT / 'data/profiles' / role),
            '--no-create-home', '--shell', '/usr/sbin/nologin', name)

    # The shared groups have no record of their own: the folders they own do.
    data = ROOT / 'data'
    carried = {'josi-ce-app': data / 'codex', 'josi-ce-voice-shared': data / 'voice/gateway', L.PC_GROUP: data / 'pc-spool'}
    for group in [*L.SHARED_GROUPS, L.PC_GROUP]:
        if exists(grp.getgrnam, group):
            continue
        folder = carried.get(group)
        gid = folder.stat().st_gid if folder is not None and folder.exists() else 0
        if gid and not exists(grp.getgrgid, gid):
            run('/usr/sbin/groupadd', '--system', '--gid', str(gid), group)
        else:
            run('/usr/sbin/groupadd', '--system', group)  # the installer re-owns the shared folders to it
    for group, members in L.SHARED_GROUPS.items():
        for role in members:
            run('/usr/sbin/usermod', '-a', '-G', group, L.ACCOUNTS[role])

    # Josi's own Chrome keeps its profile in a volume, and with it a lock that
    # names the OLD container as the machine using it. No Chrome can be running
    # in a container this new, so the lock is stale; left there, Chrome refuses
    # to start ("profile in use on another computer").
    profile = Path('/var/lib/josi-pc/browser/profile')
    for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
        try: (profile / name).unlink()
        except OSError: pass

    installer = L.Lifecycle(RUNTIME, progress=lambda phase, service: None)
    for role, path in units.items():
        L.durable(path, installer.unit(role, program), mode=0o644)
    run('/usr/bin/systemctl', 'daemon-reload')
    for role in L.ROLES:
        run('/usr/bin/systemctl', 'enable', L.UNIT_PREFIX + role + '.service')

    if version == installer.version:
        # Same version as this image: nothing to upgrade, so nothing else would start it.
        say('starting Josi')
        for role in L.ROLES:
            run('/usr/bin/systemctl', 'start', L.UNIT_PREFIX + role + '.service')
    else:
        say(f'the installer will now upgrade {version} to {installer.version}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        say('a step failed: ' + ' '.join(map(str, error.cmd[:3])) + ': ' + (error.stderr or b'').decode(errors='replace')[:300])
        sys.exit(1)
    except Exception as error:  # the data is untouched either way
        say(f'stopped: {type(error).__name__}: {error}')
        sys.exit(1)

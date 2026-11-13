#!/usr/bin/env python3
"""A typed-answers run of the Linux installer, through a real pseudo-terminal.

The other VM runs use --yes and never draw or read the questions, so they missed
lost keystrokes (sudo-rs) and screen drift. This one runs the installer the way
a person does: a terminal of a fixed size, the questions on screen, every answer
typed key by key with a short pause, and then it checks that the machine ended
up exactly as typed. A lost or doubled key changes the port, the user or the
answer, so the check catches it.

Run it on a machine that is fine to install on (a test VM), as a login user with
sudo. It installs for real.

    python3 e2e-typed-install.py ~/josi-release/install.sh
    python3 e2e-typed-install.py ./linux --port 8099 --browser n --delay 0.1
"""
import argparse, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time, urllib.request

ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]|\r')
clean = lambda data: ANSI.sub('', data.decode('utf-8', 'replace'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('installer', help='install.sh in a release folder, a folder holding it, or the one-command "linux" file')
    ap.add_argument('--port', default='8099', help='the port to type (default 8099)')
    ap.add_argument('--user', default=os.environ.get('SUDO_USER') or os.environ.get('USER') or 'roman', help='the Linux user to type for PC control')
    ap.add_argument('--browser', default='n', choices=['y', 'n'], help="answer to \"Give Josi her own browser?\" (n keeps the run short)")
    ap.add_argument('--delay', type=float, default=0.06, help='seconds between typed keys')
    ap.add_argument('--timeout', type=int, default=1800, help='seconds for the whole install')
    ap.add_argument('--cols', type=int, default=99)
    ap.add_argument('--rows', type=int, default=30)
    args = ap.parse_args()

    installer = args.installer
    if os.path.isdir(installer): installer = os.path.join(installer, 'install.sh')
    if not os.path.isfile(installer): sys.exit(f'not found: {installer}')

    # What the person is asked, in order, and what they type. Ctrl-U clears an
    # answer the question shows ready-made, so what is typed is all there is.
    steps = [
        ('Choose 1, 2 or 3:', '1\r'),
        ("This server's address on your network:", '\r'),
        ('Port:', '\x15' + args.port + '\r'),
        ('Allow it? (y/n):', 'y\r'),
        ('Which Linux user should Josi act as?', '\x15' + args.user + '\r'),
        ('Add it? (y/n):', args.browser + '\r'),
        ('Install Josi now? (y/n):', 'y\r'),
    ]
    # An existing Josi is updated with one question instead.
    update_step = ('Go ahead? (y = yes, c = change these settings first):', 'y\r')

    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(TERM='xterm-256color', LANG='C.UTF-8', LC_ALL='C.UTF-8')
        os.execvp('sudo', ['sudo', 'bash', installer])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))

    seen = b''
    cursor = 0           # where in the cleaned text the next question must appear
    pending = list(steps)
    typed = []
    deadline = time.time() + args.timeout
    status = None
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 1.0)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b''
            if not chunk: break
            seen += chunk
            sys.stdout.buffer.write(chunk); sys.stdout.flush()
        text = clean(seen)
        for step in ([update_step] if not typed else []) + pending[:1]:
            prompt, keys = step
            at = text.find(prompt, cursor)
            if at < 0: continue
            time.sleep(0.5)  # let the line editor settle, as a person would
            for key in keys:
                os.write(fd, key.encode()); time.sleep(args.delay)
            cursor = at + len(prompt)
            typed.append(prompt)
            if step is pending[0]: pending.pop(0)
            break
        done, status = os.waitpid(pid, os.WNOHANG)
        if done: break
    else:
        os.kill(pid, signal.SIGKILL); sys.exit('FAIL timed out')
    if status is None: _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    tail = clean(seen)

    results = []
    def check(name, ok, detail=''):
        results.append(ok); print(f"\n{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}", flush=True)

    check('every question was shown and answered', not pending, 'unanswered: ' + '; '.join(p for p, _ in pending) if pending else '')
    check('the installer finished', code == 0, f'exit {code}')
    check('no failure was reported', 'Something went wrong' not in tail)
    try: port = json.load(open('/var/lib/josi/status.json')).get('publicPort')
    except Exception as error: port = f'unreadable ({error})'
    check('the port is the one typed', str(port) == args.port, f'wanted {args.port}, got {port}')
    try: ready = urllib.request.urlopen(f'http://127.0.0.1:{args.port}/ready', timeout=10).status
    except Exception as error: ready = str(error)[:60]
    check('Josi answers on that port', ready == 200, str(ready))
    pc_user = subprocess.run(['systemctl', 'show', '-p', 'User', '--value', 'josi-pc'], capture_output=True, text=True).stdout.strip()
    check('PC control runs as the user typed', pc_user == args.user, f'wanted {args.user}, got {pc_user or "none"}')
    browser = subprocess.run(['systemctl', 'is-enabled', 'josi-browser'], capture_output=True, text=True).stdout.strip() == 'enabled'
    check('the browser answer was kept', browser == (args.browser == 'y'), f'own browser enabled: {browser}')
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


if __name__ == '__main__':
    main()

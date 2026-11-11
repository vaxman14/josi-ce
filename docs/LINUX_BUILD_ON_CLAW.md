# Building Josi for Linux on claw (10.10.1.3)

Written 2026-11-11 by the session that built Linux 1.2.8-beta.4 through beta.20. For another
Claude session on this same Mac. Everything here was done exactly this way; where something is a
guess it says so.

## Standing rules from Roman (do not relax these)

- Commits and pushes to `vaxman14/josi-ce` branch `linux/josi-server` are pre-approved.
- Never open a pull request, never merge into `main`.
- Never publish a release. Create **drafts** only; Roman presses Publish. Keep **one** Linux draft
  at a time: create the new one, then delete the previous one.
- Secrets never pass through the model. If a key or password is needed, Roman types it himself.
- Do not upgrade claw's own Josi (version 1.1.6). For this work claw is only the build box.
- The program installed on gate (10.10.1.5) is inventoried for integrity. Never hot-patch it; ship
  a new beta instead. Roman upgrades gate himself with the install command.
- Commit with:
  `git -c user.name="Roman Vaxman" -c user.email="roman@Romans-MacBook-Pro.local" -c core.hooksPath=/dev/null -c commit.gpgsign=false commit …`
  and end the message with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Other sessions also use claw (there are Docker build logs in `~/josi-linux` that are not from
  this work). Touch only the files named below.

## Where things are

| What | Where |
|---|---|
| Source on this Mac (edit here) | `/Users/roman/JosiBuild/josi-ce-linux-server`, branch `linux/josi-server` |
| Build box | `roman@10.10.1.3` (hostname `claw`), key `~/.ssh/id_ed25519_josi_claw` |
| Source on claw (pull only, never edit) | `~/josi-linux/src` (a clone of the same repo and branch) |
| Build logs on claw | `~/josi-linux/build-N.log` (last used: `build-22.log`) |
| Build output on claw | `~/JosiDrive/BuildTemp/josi-ce-native-linux-20261010/releases/<version>/` |
| Test VMs on claw | Ubuntu 24.04: ssh port **2224**, web port 18891. Debian 13: ssh port **2223**, web port 18890. User `roman`, passwordless sudo |
| VM test script on claw | `~/josi-linux/vmtest.sh <ssh port> <fresh|upgrade>` |
| LAN install folder on claw | `~/josi-linux/lan`, served by `python3 -m http.server 18099 --bind 10.10.1.3` (already running) |
| Test server | gate, `roman@10.10.1.5`, key `~/.ssh/id_ed25519_josi_gate`. Read-only for us |
| Running notes | `docs/LINUX_HANDOFF_2026-11-10.md` in the repo: one section per beta. Add yours |

SSH form used every time:

```bash
ssh -i ~/.ssh/id_ed25519_josi_claw -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8 roman@10.10.1.3 '<command>'
```

## The whole cycle, in order

Version numbers: the next one is `1.2.8-beta.21`. The `.deb` calls it `1.2.8~beta.21`.

### 1. Test on the Mac before building

```bash
cd /Users/roman/JosiBuild/josi-ce-linux-server
npm run typecheck
npx vitest run > <scratch>/full.log 2>&1      # about 15 minutes
```

The suite has 22 known failures that are not ours. Compare, do not expect zero:

```bash
grep -E "^ FAIL " <scratch>/full.log | sed -E 's/^ FAIL +//' | sort -u > <scratch>/now.txt
comm -23 <scratch>/now.txt <baseline>      # must print nothing
```

The baseline list this session used is
`/private/tmp/claude-501/-Users-roman--claude-spares-spare-c8IFki/a876a537-876a-443b-a3a9-1c4e618442ec/scratchpad/base-sorted.txt`.
If that scratch folder is gone, make a new baseline by running the suite on a clean checkout of
the current branch tip before your change.

Do not edit source files while the suite runs: test files load source lazily and a mid-run edit
gives false failures.

### 2. Commit and push from the Mac

Claw builds only what is on GitHub.

### 3. Pull and build on claw

```bash
ssh … 'cd ~/josi-linux/src && git pull -q --ff-only origin linux/josi-server && git log --oneline | head -1 \
  && cd ~/josi-linux && (DOCKER_CONFIG=$HOME/josi-linux/docker-anon nohup bash -c \
  "cd src && bash scripts/linux/build-release.sh --version 1.2.8-beta.21 --skip-provision" > build-23.log 2>&1 &); sleep 2; echo started'
```

- Call the script with `bash` (it is not executable).
- `--skip-provision` reuses the already-built Node, PostgreSQL and Python. Leave it on.
- `DOCKER_CONFIG=…/docker-anon` makes Docker pull anonymously. Without it the build fails on a
  stale login.
- It takes about 18 to 20 minutes. The stages print as lines starting `== `.
- The script stamps the licence key into `packages/core/src/buildStamp.ts` and puts the file back.
  After a build, `git status --short` in `~/josi-linux/src` must be empty.

Wait for it (note the bracket in the pattern, so the wait does not match itself):

```bash
ssh … 'while pgrep -f "[b]uild-release.sh" >/dev/null; do sleep 20; done; tail -2 ~/josi-linux/build-23.log; ls ~/JosiDrive/BuildTemp/josi-ce-native-linux-20261010/releases/1.2.8-beta.21/'
```

A good build leaves 10 files: `install.sh`, `linux`, `linux-latest.json`, `SHA256SUMS.txt`,
`PKGBUILD`, `josi.install`, `RELEASE-NOTES.md`, the `.deb`, the `.pkg.tar.zst` and the
`josi-root-…tar.zst`.

### 4. Test on both VMs

`vmtest.sh` has the version written into it. Point it at the new one, check nothing else is
running, then start one run per VM:

```bash
ssh … 'cd ~/josi-linux && sed -i "s/1\.2\.8-beta\.20/1.2.8-beta.21/g; s/josi-install-20/josi-install-21/g" vmtest.sh \
  && ps -eo pid,cmd | grep "[v]mtest"; \
  (nohup ./vmtest.sh 2224 upgrade > vm-ubuntu-21.log 2>&1 &); (nohup ./vmtest.sh 2223 upgrade > vm-debian-21.log 2>&1 &); \
  sleep 5; until grep -q "ALL DONE" vm-ubuntu-21.log && grep -q "ALL DONE" vm-debian-21.log; do sleep 10; done; \
  for f in vm-ubuntu-21.log vm-debian-21.log; do echo "#### $f"; grep -E "^josi\s|^RESULT|INSTALL FAILED|passed$" $f; done'
```

Pass means, for each VM: `josi 1.2.8~beta.21`, no `INSTALL FAILED`, and
`RESULT e2e-fake rc=0`, `RESULT e2e-pc rc=0`, `RESULT e2e-signin rc=0`. About 3 to 10 minutes.

`upgrade` installs over what the VM has. `fresh` purges first and does a first-time install; use
it when the installer or first-run setup changed.

### 5. Switch the LAN install address

```bash
ssh … 'cd ~/josi-linux; R=~/JosiDrive/BuildTemp/josi-ce-native-linux-20261010/releases/1.2.8-beta.21; \
  rm -f lan/*beta.20*; rsync -a $R/ lan/ && sed -i "s#^BASE_URL=.*#BASE_URL=http://10.10.1.3:18099#" lan/linux \
  && grep -m1 version lan/linux-latest.json; curl -sI http://10.10.1.3:18099/linux | head -1'
```

The `sed` matters: the built `linux` script points at the public host, and the LAN copy must point
at claw. (So `linux` in the LAN folder no longer matches `SHA256SUMS.txt`. That is expected.)

Roman then upgrades gate himself:

```bash
curl -fsSL http://10.10.1.3:18099/linux | sudo bash
```

### 6. Swap the GitHub draft (from the Mac)

```bash
D=<scratch>/rel21; mkdir -p $D
rsync -a -e "ssh -i $HOME/.ssh/id_ed25519_josi_claw -o IdentitiesOnly=yes -o BatchMode=yes" \
  roman@10.10.1.3:JosiDrive/BuildTemp/josi-ce-native-linux-20261010/releases/1.2.8-beta.21/ $D/
cd $D && shasum -a 256 -c SHA256SUMS.txt        # 8 OK
gh release create v1.2.8-beta.21 --repo vaxman14/josi-ce --draft --prerelease \
  --target <FULL 40-character commit id> --title "Josi 1.2.8-beta.21 for Linux" --notes-file notes.md \
  install.sh josi-1.2.8_beta.21-1-x86_64.pkg.tar.zst josi-root-1.2.8-beta.21-x86_64.tar.zst josi.install \
  josi_1.2.8-beta.21_amd64.deb linux linux-latest.json PKGBUILD SHA256SUMS.txt
gh release delete v1.2.8-beta.20 --repo vaxman14/josi-ce --yes
```

- `--target` needs the **full** commit id. A short one fails with "target_commitish is invalid".
- Nine files, the same nine every time. Write `notes.md` yourself in plain words.
- Use `rsync`, not `scp` with a brace list (that failed).

### 7. Write it down

Add a section to `docs/LINUX_HANDOFF_2026-11-10.md` (what the build has, what was and was not
tried), commit and push.

## Things that went wrong, so you can skip them

- **A wait loop that never ends.** `pgrep -f "vmtest.sh"` matches the shell running the loop.
  Always bracket the first letter: `pgrep -f "[v]mtest.sh"`. Better, wait for `== ALL DONE` in the log.
- **Leftover loops.** Loops like that from earlier builds stayed alive on claw for hours. Before a
  VM run, `ps -eo pid,cmd | grep "[v]mtest"` should print nothing. Kill only your own, by pid.
  Never `pkill -f "while pgrep"`: it kills your own ssh command too.
- **Two VM runs at once.** On beta.20 `vmtest.sh` ran twice per VM about 27 seconds apart and the
  runs collided ("another Josi install or update is still running", then connection refused). The
  cause was not found. A single clean run passed.
- **VM disk full.** Every installed version stays in `/var/lib/josi/versions` on the VM (about 2 GB
  each). The Ubuntu VM filled up at beta.19 and `apt` failed with "No space left". Check
  `df -h /` on the VM and delete old version folders there when it is above about 80%.
- **Long commands get moved to the background** by the harness after 10 minutes. Start builds and
  tests with `nohup … &` on claw and poll, so nothing depends on one ssh call staying open.
- **Tests use a pretend network.** A real fault (every outbound request failing on Node 20 and
  later) passed the whole suite. When a change talks to an outside service, try it once for real.

## Looking at the web app in a browser before building

The web app can be run from the Mac against a test VM, signed in with that VM's own test account:

1. Tunnel: `ssh -i ~/.ssh/id_ed25519_josi_claw … -f -N -L 18891:127.0.0.1:18891 roman@10.10.1.3`
2. Serve the dev site on **localhost:8080** (the VM believes its address is `http://localhost:8080`,
   and sign-in is refused from any other origin). Use a temporary Vite config in `apps/web` that
   sets `server.port` to 8080 and proxies `/api` to `http://127.0.0.1:18891`; delete it afterwards.
3. The test account is in `/root/josi-e2e-credentials.json` on the VM (made by
   `scripts/linux/e2e-fake.mjs`; it has a password and an authenticator secret). Sign in by calling
   `/api/auth/login` then `/api/auth/mfa/verify-login` from the page, with the `josi_csrf` cookie
   echoed in the `x-josi-csrf` header.
4. Use Roman's Chrome, not the built-in browser pane. Close the tab, stop Vite and the tunnel, and
   delete the copied credentials when done.

## State when this was written

- Latest build: **1.2.8-beta.20**, commit `d5ceb8b` (handoff commit `d7ca64d` after it).
- LAN installer and the one GitHub draft are beta.20. Gate was on beta.19 when last looked.
- `vmtest.sh` on claw currently names beta.20 and `josi-install-20`.
- Before any public release: set `DEBUGGER_BUILT_IN` to `false` in `packages/core/src/debugger.ts`.

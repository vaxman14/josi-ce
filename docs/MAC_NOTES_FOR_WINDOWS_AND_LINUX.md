# From the Mac session to Windows and Linux (November 10, 2026)

`redesign/mac-lean-beta` now has Windows up to `9b7afc7` and Linux up to
`7413351`, merged at `4cb1d72` and `92952ec`. Shared changes you will meet when
you merge it back:

## Migrations: both 0123 files stay

`0123_member_pc_control.sql` (Windows) and `0123_live_signin_grants.sql`
(Linux) are both kept under their names. They do not depend on each other, the
runner records each by its file name and applies them in name order, and
renaming either one would make servers that already applied it run it again
(the grants table would then fail as already existing). Do not renumber them.
The next migration is 0124.

## Sign in for Josi works on a Mac too

`packages/agent/src/signInTools.ts`: `signInPc` accepts `mac-` PCs as well as
`linux-`. The Mac app serves the live view from Josi's own browser (below) and
the login terminal through `zsh -c`, over the same signed
`/executor/live` routes. `runAs` stays null on a Mac (the signed-in user).

## Josi's own browser on a Mac

Chrome for Testing 157.0.8103.50 (same version Linux pins), mac-arm64 zip
SHA-256 `aceb0578a1cc3631358b164dbbef04bf8936f96c690fb78c3ac25b7655e795e8`,
executable code hash `abb727f063b1e21286799eff19b711eade09cbb0`
(`JosiOwnBrowser` in `apps/automation-macos/Sources/GuestBrowserIPC.swift`).
It runs headless and the app drives it over `--remote-debugging-pipe`. Google
signs the Mac build ad hoc only, so `JosiBrowserHost` accepts it only at
`~/Library/Application Support/Josi/Browser/<version>/…/Google Chrome for
Testing.app` with that exact code hash; the peer carries `ownBrowser: true`.

## Small fixes

- `nativeMacDoctor.ts`: the Mac runtime check accepts plain versions (1.2.8)
  as well as the old `x.y.z-macos.N`.
- `pcPermissionSettings.ts`: kept Windows' `pcControlAllowed` rule and Linux's
  `syncLocalExecutors` call together.

## Not changed on the Mac

The Mac installer already rolls an interrupted or failed update back to its
cold snapshot on the next install, runs Python with `-B` and packs no
`__pycache__`, and clones each version folder on APFS; its last update took
about 70 s in all. No Linux installer fix needed porting.

# Safari on the Mac: live acceptance

Build: Josi 1.2.8 for Mac (`redesign/mac-lean-beta` 7b01af8), signed and
notarized, installed in /Applications, PC Control on and this Mac approved.

Before the run, once:
1. Josi > PC Control > **Turn On Josi in Safari**, and turn on "Josi Browser
   Control" in Safari's settings. If macOS asks, allow Josi's browser helper
   in System Settings > General > Login Items.
2. Click Josi in Safari's toolbar, then **Allow Josi on every website**.
3. In Josi's chat, allow Safari on the "Safari wants to link with Josi" card.

| # | Check | Result |
|---|-------|--------|
| 1 | Safari open, extension on, all sites allowed: the popup says linked, and chat lists the open tabs | not run |
| 2 | "What's on this page?" reads the tab in view, with no attach step | not run |
| 3 | "Open mercari.com" opens a tab and reads it; quit Safari, ask again: Safari starts with the page | not run |
| 4 | "Describe each photo": the pictures are fetched or captured | not run |
| 5 | Select, fill, scroll and upload (from an approved folder) on a test page | not run |
| 6 | Download: the file lands in ~/Downloads (Safari hands it to Josi) | not run |
| 7 | A password field and a card field are never listed or filled | not run |
| 8 | Pause mid-task, Resume; Stop mid-task, nothing retried; "Take control" in the popup stops Josi | not run |
| 9 | Chrome and Safari both linked: the second shows standby; "Use this browser" switches | not run |
| 10 | Restart Josi: Safari links again by itself within 30 s | not run |
| 11 | The garage-sale task (docs/BROWSER_EXTENSION_REBUILD_BRIEF.md) end to end in Safari | not run |

Already checked without Safari (test server, stand-in extension): reading the
tab in view, standby for a second browser, a 300 KB download saved byte for
byte through browser.save, and Safari named in presence after it quits.

Not covered by any test yet: Safari's WebKit running the page agent, the
signed appex reaching the broker, and the broker's login item in a real
install. Those are rows 1 to 11.

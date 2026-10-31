// Fills the download page from GitHub Releases of vaxman14/josi-ce, so a
// published release is the only step that changes what people download.
//
// Release families, by tag:
//   v<major.minor.patch>[-linux.N]  the server and app installers (Windows exe,
//                                   Mac dmg/pkg, Linux packages and install script)
//   desktop-v<version>              the desktop client apps for a PC that only
//                                   connects to a server elsewhere
// Drafts are never shown. Pre-releases are shown only when no final release
// carries that platform's file, and then marked as a preview.
(function () {
  'use strict';
  var API = 'https://api.github.com/repos/vaxman14/josi-ce/releases?per_page=60';
  var RELEASES = 'https://github.com/vaxman14/josi-ce/releases';
  var PATTERNS = {
    windows: /^Josi-CE-\d[^/]*-Windows-x64\.exe$/i,
    mac: /^Josi-CE-\d[^/]*-macOS[^/]*\.(dmg|pkg)$/i,
    linuxScript: /^install-josi-ce-server\.sh$/i,
    linuxPackage: /\.(deb|rpm|run|AppImage|pkg\.tar\.zst)$/i,
    sums: /^SHA256SUMS[^/]*\.txt$/i,
  };
  var $ = function (sel) { return document.querySelector(sel); };
  var mb = function (bytes) { return Math.round(bytes / 1048576) + ' MB'; };
  var day = function (iso) { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }); };

  function detect() {
    var ua = navigator.userAgent, p = navigator.platform || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Mac/i.test(p) && !/iPhone|iPad/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return 'linux';
    return null;
  }
  function highlight(which) {
    var ids = { windows: 'door-windows', mac: 'door-mac', linux: 'door-linux' };
    if (!which) return;
    var door = document.getElementById(ids[which]);
    door.classList.add('hot');
    var tag = door.querySelector('.tag'); tag.classList.add('on'); tag.textContent = 'This computer';
    var button = door.querySelector('.pill'); if (button) button.classList.add('primary', 'big');
  }

  function pick(releases, family, pattern) {
    // Newest release of the family that carries a matching file; final releases first.
    var candidates = releases.filter(function (r) { return !r.draft && family.test(r.tag_name); })
      .sort(function (a, b) { return new Date(b.published_at) - new Date(a.published_at); });
    var finals = candidates.filter(function (r) { return !r.prerelease; });
    var groups = [finals, candidates];
    for (var g = 0; g < groups.length; g++) {
      for (var i = 0; i < groups[g].length; i++) {
        var assets = groups[g][i].assets.filter(function (a) { return pattern.test(a.name); });
        if (assets.length) return { release: groups[g][i], assets: assets };
      }
    }
    return null;
  }
  function setDoor(key, found, label) {
    var link = $('[data-asset="' + key + '"]'), meta = $('[data-meta="' + key + '"]');
    if (!found) {
      link.setAttribute('aria-disabled', 'true'); link.textContent = label + ': being prepared';
      meta.textContent = 'Not in the latest release yet. Check back soon.';
      return;
    }
    var a = found.assets[0];
    link.href = a.browser_download_url; link.textContent = label;
    meta.textContent = a.name + ' · ' + mb(a.size) + ' · ' + found.release.tag_name.replace(/^v/, '') +
      (found.release.prerelease ? ' (preview)' : '') + ' · ' + meta.textContent;
  }

  function render(releases) {
    var server = /^v\d+\.\d+\.\d+/, desktop = /^desktop-v\d/;
    var win = pick(releases, server, PATTERNS.windows);
    var mac = pick(releases, server, PATTERNS.mac);
    var linux = pick(releases, server, PATTERNS.linuxScript) || pick(releases, server, PATTERNS.linuxPackage);
    setDoor('windows', win, 'Download for Windows');
    setDoor('mac', mac, 'Download for Mac');
    var latest = [win, mac, linux].filter(Boolean).map(function (f) { return f.release; })
      .sort(function (a, b) { return new Date(b.published_at) - new Date(a.published_at); })[0];
    if (linux) {
      var packages = $('[data-asset="linux-packages"]');
      packages.href = linux.release.html_url;
      var script = linux.release.assets.filter(function (a) { return PATTERNS.linuxScript.test(a.name); })[0];
      if (script) $('#linux-command').textContent = 'curl -fsSL ' + script.browser_download_url + ' -o install.sh\nsudo bash install.sh';
    }
    if (latest) {
      $('#release-line').textContent = 'Version ' + latest.tag_name.replace(/^v/, '') + ' · released ' + day(latest.published_at) + ' · free';
      var sums = latest.assets.filter(function (a) { return PATTERNS.sums.test(a.name); })[0];
      $('#sums-link').href = sums ? sums.browser_download_url : latest.html_url;
      $('#sums-link').textContent = sums ? sums.name + ' for ' + latest.tag_name.replace(/^v/, '') : 'Checksums on the release page';
      var notes = $('#notes');
      notes.textContent = '';
      var title = document.createElement('p'); title.style.fontWeight = '600'; title.style.color = 'var(--fg)';
      title.textContent = latest.name || latest.tag_name; notes.appendChild(title);
      (latest.body || 'See the release page.').split(/\r?\n/).filter(function (l) { return l.trim(); }).slice(0, 12).forEach(function (line) {
        var p = document.createElement('p'); p.textContent = line.replace(/^[-*#]+\s*/, ''); notes.appendChild(p);
      });
      var more = document.createElement('a'); more.href = latest.html_url; more.rel = 'noopener'; more.textContent = 'Full notes on GitHub';
      notes.appendChild(more);
    } else {
      $('#release-line').textContent = 'No release is published yet. The releases page lists what exists.';
    }
    var clients = pick(releases, desktop, /\.(exe|dmg|AppImage|deb)$/i);
    if (clients) {
      var box = $('#desktop-clients'); box.textContent = 'Desktop app ' + clients.release.tag_name.replace(/^desktop-v/, '') + ': ';
      clients.release.assets.filter(function (a) { return /\.(exe|dmg|AppImage|deb)$/i.test(a.name); }).forEach(function (a, i) {
        if (i) box.appendChild(document.createTextNode(' · '));
        var link = document.createElement('a'); link.href = a.browser_download_url; link.rel = 'noopener';
        link.textContent = a.name.replace(/^Josi-CE-(Setup-)?[\d.]+-/, '').replace(/\.(exe|dmg|AppImage|deb)$/, function (m) { return ' (' + m.slice(1) + ')'; });
        box.appendChild(link);
      });
    }
  }

  function failed() {
    $('#release-line').innerHTML = 'The version list could not be loaded right now. Every download is on <a href="' + RELEASES + '" rel="noopener">the releases page</a>.';
  }

  highlight(detect());
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem('josi-releases') || 'null'); } catch (e) { cached = null; }
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) { render(cached.releases); return; }
  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (releases) {
      try { localStorage.setItem('josi-releases', JSON.stringify({ at: Date.now(), releases: releases })); } catch (e) { /* private window */ }
      render(releases);
    })
    .catch(function () { if (cached) render(cached.releases); else failed(); });
})();

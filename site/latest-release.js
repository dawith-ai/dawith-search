/*
 * Fills elements marked with data-latest="..." from the latest GitHub release,
 * so a new release shows up here without editing the site.
 * The static HTML holds fallback values; on any failure nothing changes.
 *
 * Keys: version (1.3.3), tag (v1.3.3), date (2026년 11월 10일), release-url (href),
 *       win-url (href), win-name, win-size-kb, win-sha256,
 *       mac-url (href), mac-name, mac-version, mac-size-kb, mac-size-mb, mac-sha256,
 *       mac-pending (hidden when the latest release ships a DMG).
 */
(function () {
  'use strict';

  var API = 'https://api.github.com/repos/dawith-ai/dawith-search/releases/latest';
  var DOWNLOAD_PREFIX = 'https://github.com/dawith-ai/dawith-search/releases/';
  var CACHE_KEY = 'dawith-latest-release:v1';
  var CACHE_MS = 10 * 60 * 1000;
  var WIN_SETUP = /^Dawith-Search_[\d.]+_x64-setup\.exe$/;
  // Prefer the lightweight Tauri Universal package over the Electron fallback.
  var MAC_DMG = /^Dawith\.Search_[\d.]+_universal\.dmg$/i;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (!cached || Date.now() - cached.savedAt > CACHE_MS) return null;
      return cached.release;
    } catch (e) {
      return null;
    }
  }

  function writeCache(release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), release: release }));
    } catch (e) {}
  }

  // Keep only the fields we use, and only values we trust.
  function pickRelease(data) {
    if (!data || typeof data.tag_name !== 'string') return null;
    var tag = data.tag_name;
    if (!/^v?\d+(\.\d+)+$/.test(tag)) return null;
    function pickAsset(test) {
      var assets = Array.isArray(data.assets) ? data.assets : [];
      for (var i = 0; i < assets.length; i++) {
        var a = assets[i];
        if (!a || typeof a.name !== 'string' || !test.test(a.name)) continue;
        if (typeof a.browser_download_url !== 'string' || a.browser_download_url.indexOf(DOWNLOAD_PREFIX) !== 0) continue;
        var sha = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : '';
        return { name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : 0, sha256: sha };
      }
      return null;
    }
    var htmlUrl = typeof data.html_url === 'string' && data.html_url.indexOf(DOWNLOAD_PREFIX) === 0 ? data.html_url : '';
    return {
      tag: tag,
      version: tag.replace(/^v/, ''),
      publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
      htmlUrl: htmlUrl,
      win: pickAsset(WIN_SETUP),
      mac: pickAsset(MAC_DMG)
    };
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
      var p = {};
      for (var i = 0; i < parts.length; i++) p[parts[i].type] = parts[i].value;
      if (p.year && p.month && p.day) return p.year + '년 ' + p.month + '월 ' + p.day + '일';
    } catch (e) {}
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  function kb(size) {
    return Math.round(size / 1024).toLocaleString('ko-KR') + ' KB';
  }

  function mb(size) {
    return (size / 1024 / 1024).toFixed(1) + ' MB';
  }

  function apply(release) {
    var win = release.win;
    var mac = release.mac;
    var dmgVersion = mac ? ((mac.name.match(/\d+(\.\d+)+/) || [release.version])[0]) : '';
    var values = {
      version: release.version,
      tag: release.tag,
      date: formatDate(release.publishedAt),
      'win-name': win && win.name,
      'win-size-kb': win && win.size ? kb(win.size) : '',
      'win-sha256': win && win.sha256,
      'mac-name': mac && mac.name,
      'mac-version': dmgVersion,
      'mac-size-kb': mac && mac.size ? kb(mac.size) : '',
      'mac-size-mb': mac && mac.size ? mb(mac.size) : '',
      'mac-sha256': mac && mac.sha256
    };
    var links = {
      'win-url': win && win.url,
      'mac-url': mac && mac.url,
      'release-url': release.htmlUrl
    };

    // The quick-start button on the home page copies the Windows card's href
    // when the OS is detected; follow it to the new installer.
    var quick = document.getElementById('os-download');
    var quickWasWin = quick && /\/Dawith-Search_[\d.]+_x64-setup\.exe$/.test(quick.getAttribute('href') || '');

    var nodes = document.querySelectorAll('[data-latest]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-latest');
      if (key === 'mac-pending') {
        if (mac) el.hidden = true;
      } else if (Object.prototype.hasOwnProperty.call(links, key)) {
        if (links[key]) el.setAttribute('href', links[key]);
      } else if (values[key]) {
        el.textContent = values[key];
      }
    }

    if (quickWasWin && win) quick.setAttribute('href', win.url);
    document.documentElement.setAttribute('data-latest-loaded', release.tag);
  }

  function run() {
    var cached = readCache();
    if (cached) {
      apply(cached);
      return;
    }
    if (!window.fetch) return;
    var controller = window.AbortController ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var release = pickRelease(data);
        if (!release || !release.win) return;
        writeCache(release);
        apply(release);
      })
      .catch(function () {})
      .then(function () {
        if (timer) clearTimeout(timer);
      });
  }

  try {
    run();
  } catch (e) {}
})();

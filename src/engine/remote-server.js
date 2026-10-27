const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

class RemoteServer {
  constructor(indexer) {
    this.indexer = indexer;
    this.app = null;
    this.server = null;
    this.port = 8888;
    this.isRunning = false;
    this.accessToken = null;
    this.requestLog = new Map();
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  async start(port = 8888) {
    if (this.isRunning) return this.getAccessInfo();

    const requestedPort = Number(port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error('Remote server port must be between 0 and 65535.');
    }

    this.port = requestedPort;
    this.accessToken = crypto.randomBytes(32).toString('hex');
    this.app = express();
    this.server = http.createServer(this.app);

    this.app.disable('x-powered-by');
    this.app.use(express.json({ limit: '32kb' }));
    this.app.use((req, res, next) => {
      if (!this.isAuthorized(req)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'Remote access token is required.' });
      }
      if (!this.isRateAllowed(req)) {
        return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
      }
      next();
    });

    // API: Search
    this.app.get('/api/search', async (req, res) => {
      try {
        const query = req.query.q || '';
        const requestedLimit = parseInt(req.query.limit, 10) || 100;
        const limit = Math.min(Math.max(requestedLimit, 1), 100);
        const results = await this.indexer.search(query, { limit, forceLocal: true });
        res.json(results);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // API: Download file
    this.app.get('/api/download', (req, res) => {
      const filePath = this.resolveAllowedFile(req.query.path);
      if (!filePath) {
        return res.status(404).send('File not found');
      }
      res.download(filePath, path.basename(filePath), { dotfiles: 'deny' });
    });

    // API: Preview / Stream media
    this.app.get('/api/preview', (req, res) => {
      const filePath = this.resolveAllowedFile(req.query.path);
      if (!filePath) {
        return res.status(404).send('File not found');
      }
      res.sendFile(filePath, { dotfiles: 'deny' });
    });

    // Serve Mobile Web UI
    this.app.get('/', (req, res) => {
      res.setHeader('Set-Cookie', `dawith_remote_token=${this.accessToken}; HttpOnly; SameSite=Strict; Max-Age=1800; Path=/`);
      res.setHeader('Cache-Control', 'no-store');
      const html = this.renderMobileHtml();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    });

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', async () => {
        this.port = this.server.address().port;
        this.isRunning = true;
        const { url, localIP } = this.getAccessInfo();
        let qrDataUrl = '';
        try {
          qrDataUrl = await QRCode.toDataURL(url);
        } catch (e) {
          console.error('QR code generation failed:', e);
        }
        resolve({ port: this.port, localIP, url, qrDataUrl });
      }).on('error', reject);
    });
  }

  stop() {
    if (this.server && this.isRunning) {
      this.server.close();
      this.isRunning = false;
      this.accessToken = null;
      this.requestLog.clear();
    }
  }

  getStatus() {
    return this.getAccessInfo();
  }

  getAccessInfo() {
    const localIP = this.getLocalIP();
    const token = this.accessToken ? `?token=${encodeURIComponent(this.accessToken)}` : '';
    return {
      isRunning: this.isRunning,
      port: this.port,
      localIP,
      url: `http://${localIP}:${this.port}/${token}`
    };
  }

  parseCookies(header = '') {
    return Object.fromEntries(String(header).split(';').map(part => part.trim().split('=')));
  }

  isAuthorized(req) {
    if (!this.accessToken) return false;
    const cookies = this.parseCookies(req.headers.cookie);
    const supplied = req.get('x-dawith-token') || req.query.token || cookies.dawith_remote_token;
    return supplied === this.accessToken;
  }

  isRateAllowed(req) {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const current = (this.requestLog.get(key) || []).filter(timestamp => now - timestamp < windowMs);
    if (current.length >= 120) {
      this.requestLog.set(key, current);
      return false;
    }
    current.push(now);
    this.requestLog.set(key, current);
    return true;
  }

  resolveAllowedFile(filePath) {
    if (!filePath || !this.indexer || !this.indexer.isWithinConfiguredRoot(filePath)) return null;
    const candidate = path.resolve(String(filePath));
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch (error) {
      return null;
    }
    if (!stat.isFile()) return null;
    try {
      const realCandidate = fs.realpathSync.native(candidate);
      const allowed = (this.indexer.config.roots || []).some(root => {
        const realRoot = fs.realpathSync.native(root);
        const relative = path.relative(realRoot, realCandidate);
        return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      });
      return allowed ? realCandidate : null;
    } catch (error) {
      return null;
    }
  }

  renderMobileHtml() {
    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Dawith Search Remote</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 16px; min-height: 100vh; }
    .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid #1e293b; padding-bottom: 12px; }
    .logo { font-size: 1.25rem; font-weight: 700; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
    .badge { font-size: 0.75rem; background: #0369a1; padding: 2px 8px; border-radius: 9999px; }
    .search-box { position: sticky; top: 0; background: #0f172a; padding-bottom: 12px; z-index: 10; }
    .input-wrapper { display: flex; background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 4px; align-items: center; }
    input { width: 100%; background: transparent; border: none; outline: none; color: #fff; font-size: 1rem; padding: 8px 12px; }
    .btn { background: #2563eb; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .chips { display: flex; gap: 6px; overflow-x: auto; padding: 8px 0; margin-bottom: 8px; }
    .chip { background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 9999px; padding: 4px 12px; font-size: 0.8rem; white-space: nowrap; cursor: pointer; }
    .chip.active { background: #38bdf8; color: #0f172a; font-weight: 600; border-color: #38bdf8; }
    .stats { font-size: 0.8rem; color: #64748b; margin-bottom: 12px; }
    .results { display: flex; flex-direction: column; gap: 8px; }
    .item { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
    .item-name { font-weight: 600; color: #f1f5f9; word-break: break-all; }
    .item-path { font-size: 0.75rem; color: #64748b; word-break: break-all; }
    .item-meta { display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: #94a3b8; margin-top: 4px; }
    .actions { display: flex; gap: 8px; }
    .action-btn { background: #334155; color: #38bdf8; text-decoration: none; padding: 4px 10px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">⚡ Dawith Search <span class="badge">모바일 원격 검색</span></div>
  </div>

  <div class="search-box">
    <div class="input-wrapper">
      <input type="text" id="searchInput" placeholder="파일명 검색 (Everything 문법 지원)..." autofocus>
      <button class="btn" onclick="doSearch()">검색</button>
    </div>
    <div class="chips">
      <div class="chip active" onclick="setFilter('')">전체</div>
      <div class="chip" onclick="setFilter('doc:')">문서</div>
      <div class="chip" onclick="setFilter('pic:')">사진</div>
      <div class="chip" onclick="setFilter('video:')">동영상</div>
      <div class="chip" onclick="setFilter('audio:')">음악</div>
      <div class="chip" onclick="setFilter('zip:')">압축</div>
    </div>
    <div class="stats" id="stats">검색어를 입력하세요.</div>
  </div>

  <div class="results" id="results"></div>

  <script>
    let currentFilter = '';
    const input = document.getElementById('searchInput');
    const resultsDiv = document.getElementById('results');
    const statsDiv = document.getElementById('stats');

    input.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    function setFilter(filter) {
      document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      currentFilter = filter;
      doSearch();
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    }

    async function doSearch() {
      const q = (currentFilter ? currentFilter + ' ' : '') + input.value.trim();
      statsDiv.textContent = '검색 중...';
      try {
        const res = await fetch('/api/search?q=' + encodeURIComponent(q));
        const data = await res.json();
        statsDiv.textContent = data.results.length + '개 항목 발견 (' + data.elapsedMs + 'ms)';
        
        resultsDiv.innerHTML = data.results.map(item => {
          const fullPath = item.path + (item.path.endsWith('\\\\') ? '' : '\\\\') + item.name;
          const isMedia = ['png','jpg','jpeg','webp','gif','mp4','webm','mp3'].includes(item.ext);
          return '<div class="item">' +
            '<div class="item-name">' + (item.isDir ? '📁 ' : '📄 ') + item.name + '</div>' +
            '<div class="item-path">' + item.path + '</div>' +
            '<div class="item-meta">' +
              '<span>' + (item.isDir ? '폴더' : formatBytes(item.size)) + '</span>' +
              '<div class="actions">' +
                (isMedia ? '<a class="action-btn" target="_blank" href="/api/preview?path=' + encodeURIComponent(fullPath) + '">보기</a>' : '') +
                (!item.isDir ? '<a class="action-btn" href="/api/download?path=' + encodeURIComponent(fullPath) + '">다운로드</a>' : '') +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      } catch (e) {
        statsDiv.textContent = '검색 오류: ' + e.message;
      }
    }
  </script>
</body>
</html>`;
  }
}

module.exports = RemoteServer;

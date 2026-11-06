const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const REPOSITORY = 'dawith-ai/dawith-search';

function normalizeVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function getAssetName(version, platform) {
  if (platform === 'win32') return `DawithSearch-${version}-setup.exe`;
  if (platform === 'darwin') return `Dawith.Search-${version}-universal.dmg`;
  return null;
}

function requestJson(url, request = https.get) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Dawith-Search-Updater'
      }
    };
    const requestHandle = request(url, requestOptions, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        requestJson(response.headers.location, request).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub update check failed (${response.statusCode})`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('GitHub update response was not valid JSON.'));
        }
      });
    });
    requestHandle.on('error', reject);
    requestHandle.setTimeout(8000, () => requestHandle.destroy(new Error('Update check timed out.')));
  });
}

function downloadFile(url, destination, request = https.get) {
  return new Promise((resolve, reject) => {
    const temporaryPath = `${destination}.download`;
    const start = targetUrl => {
      const requestHandle = request(targetUrl, { headers: { 'User-Agent': 'Dawith-Search-Updater' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          start(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Update download failed (${response.statusCode})`));
          return;
        }
        const output = fs.createWriteStream(temporaryPath);
        response.pipe(output);
        output.on('finish', () => {
          output.close(() => {
            fs.renameSync(temporaryPath, destination);
            resolve(destination);
          });
        });
        output.on('error', error => {
          output.destroy();
          reject(error);
        });
      });
      requestHandle.on('error', reject);
      requestHandle.setTimeout(120000, () => requestHandle.destroy(new Error('Update download timed out.')));
    };
    start(url);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function checkForUpdates(currentVersion, platform, request = https.get) {
  const release = await requestJson(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, request);
  const latestVersion = String(release.tag_name || '').replace(/^v/i, '');
  const assetName = getAssetName(latestVersion, platform);
  const asset = (release.assets || []).find(item => item.name === assetName);
  if (!latestVersion || !assetName || !asset) {
    return { supported: false, available: false, currentVersion, reason: 'platform-asset-unavailable' };
  }
  return {
    supported: true,
    available: compareVersions(latestVersion, currentVersion) > 0,
    currentVersion,
    latestVersion,
    releaseUrl: release.html_url,
    asset: {
      name: asset.name,
      url: asset.browser_download_url,
      digest: asset.digest || null,
      size: asset.size
    }
  };
}

async function downloadAndVerify(update, destination, request = https.get) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await downloadFile(update.asset.url, destination, request);
  const expectedDigest = String(update.asset.digest || '').replace(/^sha256:/i, '').toLowerCase();
  if (expectedDigest) {
    const actualDigest = await sha256File(destination);
    if (actualDigest !== expectedDigest) {
      fs.unlinkSync(destination);
      throw new Error('다운로드한 업데이트 파일의 SHA-256 검증에 실패했습니다.');
    }
  }
  return destination;
}

module.exports = {
  REPOSITORY,
  normalizeVersion,
  compareVersions,
  getAssetName,
  checkForUpdates,
  downloadAndVerify,
  sha256File
};

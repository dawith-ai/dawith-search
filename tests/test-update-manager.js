const assert = require('assert');
const { EventEmitter } = require('events');
const {
  checkForUpdates,
  compareVersions,
  getAssetName,
  normalizeVersion
} = require('../src/main/update-manager');

assert.deepStrictEqual(normalizeVersion('v1.0.7'), [1, 0, 7]);
assert.strictEqual(compareVersions('1.0.7', '1.0.6'), 1);
assert.strictEqual(compareVersions('v1.0.7', '1.0.7'), 0);
assert.strictEqual(compareVersions('1.0.6', '1.0.7'), -1);
assert.strictEqual(getAssetName('1.0.7', 'win32'), 'DawithSearch-1.0.7-portable.exe');
assert.strictEqual(getAssetName('1.0.7', 'darwin'), 'Dawith.Search-1.0.7-universal.dmg');
assert.strictEqual(getAssetName('1.0.7', 'linux'), null);

function mockGithubRequest(payload) {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    process.nextTick(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {};
      response.resume = () => {};
      callback(response);
      response.emit('data', Buffer.from(JSON.stringify(payload)));
      response.emit('end');
    });
    return request;
  };
}

(async () => {
  const update = await checkForUpdates('1.0.6', 'win32', mockGithubRequest({
    tag_name: 'v1.0.7',
    html_url: 'https://github.com/dawith-ai/dawith-search/releases/tag/v1.0.7',
    assets: [{
      name: 'DawithSearch-1.0.7-portable.exe',
      browser_download_url: 'https://example.test/DawithSearch-1.0.7-portable.exe',
      digest: 'sha256:abc123',
      size: 123
    }]
  }));
  assert.strictEqual(update.supported, true);
  assert.strictEqual(update.available, true);
  assert.strictEqual(update.asset.digest, 'sha256:abc123');

  const macUpdate = await checkForUpdates('1.0.6', 'darwin', mockGithubRequest({
    tag_name: 'v1.0.7',
    html_url: 'https://github.com/dawith-ai/dawith-search/releases/tag/v1.0.7',
    assets: [{
      name: 'Dawith.Search-1.0.7-universal.dmg',
      browser_download_url: 'https://example.test/Dawith.Search-1.0.7-universal.dmg',
      digest: 'sha256:def456',
      size: 456
    }]
  }));
  assert.strictEqual(macUpdate.supported, true);
  assert.strictEqual(macUpdate.available, true);
  assert.strictEqual(macUpdate.asset.name, 'Dawith.Search-1.0.7-universal.dmg');

  console.log('Update manager contract tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

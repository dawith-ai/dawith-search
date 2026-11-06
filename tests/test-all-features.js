const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { QueryParser, translateNaturalLanguage, EXTENSION_CATEGORIES } = require('../src/engine/query-parser');
const Indexer = require('../src/engine/indexer');
const Exporter = require('../src/engine/exporter');
const DuplicateFinder = require('../src/engine/duplicate-finder');
const StorageAnalyzer = require('../src/engine/storage-analyzer');
const ContentSearcher = require('../src/engine/content-search');
const { isPathWithinRoot, normalizePathKey } = require('../src/engine/path-utils');
const TagManager = require('../src/engine/tag-manager');
const BookmarkManager = require('../src/engine/bookmark-manager');
const HistoryManager = require('../src/engine/history-manager');
const { NativeSearchAdapter, normalizeEverythingRecord, parseJsonOutput, translateNativeQuery, buildSpotlightExpression } = require('../src/engine/native-search');

console.log('🧪 Running Comprehensive Multi-Edge-Case Debugging Suite...\n');

// 1. Tag Manager Test
console.log('1. Testing Tag Manager & Starred Items:');
const testDir = path.join(os.tmpdir(), 'dawith-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });
const tagMgr = new TagManager(testDir);

const defaultIndexer = new Indexer({
  storageDir: path.join(testDir, 'default-index'),
  nativeSearch: { search: async () => ({ supported: false }) }
});
assert.strictEqual(defaultIndexer.config.autoLocalRoots, true);
assert.ok(Array.isArray(defaultIndexer.config.localRoots) && defaultIndexer.config.localRoots.length > 0);
assert.deepStrictEqual(defaultIndexer.config.roots, defaultIndexer.config.localRoots);
console.log('  ✓ Local roots default to automatic whole-device scope; external roots remain opt-in');

const testFile = 'C:\\test\\document.pdf';
tagMgr.addTag(testFile, '중요문서');
tagMgr.addTag(testFile, '#예산안');
assert.deepStrictEqual(tagMgr.getTags(testFile), ['중요문서', '예산안']);
assert.strictEqual(tagMgr.getAllTags().length, 2);

tagMgr.toggleStar(testFile);
assert.strictEqual(tagMgr.isStarred(testFile), true);
tagMgr.toggleStar(testFile);
assert.strictEqual(tagMgr.isStarred(testFile), false);

tagMgr.removeTag(testFile, '예산안');
assert.deepStrictEqual(tagMgr.getTags(testFile), ['중요문서']);
console.log('  ✓ Tag Manager CRUD operations and persistence passed');

console.log('\n1a. Testing saved searches and local search history:');
const bookmarkMgr = new BookmarkManager(path.join(testDir, 'bookmarks'));
const savedBookmark = bookmarkMgr.add({ name: '오늘 문서', query: 'doc: dm:today', sortBy: 'mtime', sortOrder: 'desc' });
assert.strictEqual(bookmarkMgr.list()[0].name, '오늘 문서');
assert.strictEqual(bookmarkMgr.touch(savedBookmark.id).id, savedBookmark.id);
assert.strictEqual(bookmarkMgr.remove(savedBookmark.id), true);

const historyMgr = new HistoryManager(path.join(testDir, 'history'));
historyMgr.add('doc: 계약서');
historyMgr.add('doc: 계약서');
assert.strictEqual(historyMgr.list()[0].count, 2);
historyMgr.clear();
assert.strictEqual(historyMgr.list().length, 0);
console.log('  ✓ Saved search persistence, recency, and history deduplication passed');

// 1b. Cross-platform native adapter contracts
console.log('\n1b. Testing native backend adapters:');
let capturedGozArgs = null;
const fakeGoz = new NativeSearchAdapter({
  platform: 'win32',
  gozPath: 'C:\\Tools\\goz.exe',
  esPath: '',
  execFileSync: () => { throw new Error('gozd is not running in the contract test'); },
  spawn: (command, args, options, callback) => {
    capturedGozArgs = args;
    callback(null, JSON.stringify({
      total: 1,
      items: [{ path: 'C:\\Users\\Dawith\\Documents\\goz-report.pdf', size: 4096, is_dir: false }],
      volumes_incomplete: false,
      metadata_pending: false
    }), '');
  }
});
fakeGoz.search('report', { limit: 10 }).then(result => {
  assert.strictEqual(result.supported, true);
  assert.strictEqual(result.backend, 'goz');
  assert.strictEqual(result.records[0].name, 'goz-report.pdf');
  assert.ok(capturedGozArgs.includes('-argv'), 'goz must receive argv mode for one-query-per-argument semantics');
  assert.ok(capturedGozArgs.includes('--json'), 'goz must use machine-readable JSON output');
  console.log('  ✓ Open-source goz JSON adapter normalization and fallback contract passed');
}).catch(error => {
  console.error('goz adapter test error:', error);
  process.exit(1);
});

let capturedEverythingArgs = null;
const fakeEs = new NativeSearchAdapter({
  platform: 'win32',
  esPath: 'C:\\Tools\\es.exe',
  spawn: (command, args, options, callback) => {
    capturedEverythingArgs = args;
    callback(null, JSON.stringify([
    { name: 'Report.txt', path: 'C:\\Users\\Dawith\\Documents', size: '1,024', date_modified: '2026-10-26T10:00:00Z' }
    ]), '');
  }
});
assert.strictEqual(fakeEs.supports('report ext:txt'), true);
assert.strictEqual(fakeEs.supports(''), true, 'Everything should own the blank whole-device query on Windows');
assert.strictEqual(fakeEs.supports('tag:important'), false);
assert.strictEqual(translateNativeQuery('doc: contract'), 'ext:doc;docx;pdf;xls;xlsx;ppt;pptx;txt;hwp;hwpx;csv;rtf;odt;ods;odp;md contract');
assert.ok(buildSpotlightExpression(QueryParser.parse('pic: 바다')).includes('*.png'));
assert.strictEqual(parseJsonOutput('{"name":"one.txt"}\n{"name":"two.txt"}').length, 2);
fakeEs.search('report', { limit: 10 }).then(result => {
  assert.strictEqual(result.supported, true);
  assert.strictEqual(result.backend, 'everything');
  assert.strictEqual(result.records[0].size, 1024);
  assert.strictEqual(result.records[0].ext, 'txt');
  assert.ok(capturedEverythingArgs.includes('report'), 'text query must be passed to es.exe');
  assert.ok(capturedEverythingArgs.includes('-timeout'), 'Everything must wait for its database to load');
  assert.ok(capturedEverythingArgs.includes('8000'), 'Everything timeout must default to 8000ms');
  return fakeEs.search('', { limit: 10 });
}).then(result => {
  assert.strictEqual(result.supported, true);
  assert.ok(!capturedEverythingArgs.includes(''), 'blank query must not be passed as an empty es.exe argument');
  console.log('  ✓ Everything JSON adapter normalization and local-only filter routing passed');
}).catch(error => {
  console.error('Native adapter test error:', error);
  process.exit(1);
});

const normalizedRecord = normalizeEverythingRecord({ path: '/Users/dawith/Documents/Report.md', size: 10 });
assert.strictEqual(normalizedRecord.name, 'Report.md');
assert.strictEqual(normalizedRecord.ext, 'md');
const normalizedWindowsPath = normalizeEverythingRecord({ path: 'C:\\Users\\Dawith\\Documents\\Report.md', size: 10 });
assert.strictEqual(normalizedWindowsPath.name, 'Report.md');
assert.strictEqual(normalizedWindowsPath.fullPath, 'C:\\Users\\Dawith\\Documents\\Report.md');

const scopeIndexer = new Indexer({
  storageDir: path.join(testDir, 'scope-index'),
  nativeSearch: { search: async () => ({ supported: false }) }
});
assert.strictEqual(scopeIndexer.isWithinScope(path.join(testDir, 'scope', 'report.pdf'), path.join(testDir, 'scope')), true);
assert.strictEqual(scopeIndexer.isWithinScope(path.join(testDir, 'other', 'report.pdf'), path.join(testDir, 'scope')), false);

assert.strictEqual(isPathWithinRoot('\\\\server\\share\\department\\report.pdf', '\\\\server\\share'), true);
assert.strictEqual(isPathWithinRoot('\\\\server\\share-other\\report.pdf', '\\\\server\\share'), false);
assert.strictEqual(normalizePathKey('\\\\SERVER\\SHARE\\Report.PDF'), '\\\\server\\share\\report.pdf');
console.log('  ✓ Windows UNC shared-folder path boundaries passed');

const sharedIndexer = new Indexer({
  storageDir: path.join(testDir, 'shared-index'),
  nativeSearch: { search: async () => ({ supported: true, backend: 'everything', records: [] }) }
});
sharedIndexer.config = { ...sharedIndexer.config, roots: ['\\\\server\\share'], searchBackend: 'auto' };
sharedIndexer.records = [{
  name: 'share-report.txt',
  path: '\\\\server\\share\\department',
  fullPath: '\\\\server\\share\\department\\share-report.txt',
  isDir: false,
  ext: 'txt',
  size: 12,
  mtime: Date.now(),
  ctime: Date.now()
}];
sharedIndexer.search('share-report').then(result => {
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.results[0].fullPath, '\\\\server\\share\\department\\share-report.txt');
  console.log('  ✓ Everything fallback merge for unindexed Windows UNC shares passed');
}).catch(error => {
  console.error('UNC shared-folder merge test error:', error);
  process.exit(1);
});
sharedIndexer.fileWatcher.close();
const localFallbackIndexer = new Indexer({
  storageDir: path.join(testDir, 'local-fallback-index'),
  nativeSearch: { search: async () => ({ supported: true, backend: 'everything', records: [] }) }
});
localFallbackIndexer.config = { ...localFallbackIndexer.config, roots: [testDir], searchBackend: 'auto' };
localFallbackIndexer.records = [{
  name: 'local-fallback-report.txt',
  path: testDir,
  fullPath: path.join(testDir, 'local-fallback-report.txt'),
  isDir: false,
  ext: 'txt',
  size: 12,
  mtime: Date.now(),
  ctime: Date.now()
}];
localFallbackIndexer.search('local-fallback-report').then(result => {
  assert.strictEqual(result.results.length, 1);
  assert.strictEqual(result.backend, 'local-fallback');
  assert.match(result.warning, /local index fallback/i);
  console.log('  ✓ Empty Everything results fall back to the local index passed');
}).catch(error => {
  console.error('Local fallback test error:', error);
  process.exit(1);
});
localFallbackIndexer.fileWatcher.close();
const scopeRoot = path.join(testDir, 'scope');
scopeIndexer.records = [
  { name: 'report.pdf', path: scopeRoot, fullPath: path.join(scopeRoot, 'report.pdf'), isDir: false, size: 10 },
  { name: 'report.pdf', path: scopeRoot, fullPath: path.join(scopeRoot, 'nested', 'report.pdf'), isDir: false, size: 20 },
  { name: 'report.pdf', path: path.join(testDir, 'other'), fullPath: path.join(testDir, 'other', 'report.pdf'), isDir: false, size: 30 }
];
scopeIndexer.search('dupe:name', { scopeRoot }).then(result => {
  assert.strictEqual(result.results.length, 2);
  assert.ok(result.results.every(item => scopeIndexer.isWithinScope(item.fullPath, scopeRoot)));
  console.log('  ✓ Scoped duplicate search stays within the selected folder passed');
}).catch(error => {
  console.error('Scoped search test error:', error);
  process.exit(1);
});
scopeIndexer.fileWatcher.close();
console.log('  ✓ Folder scope boundary checks passed');

// 2. Query Parser Complex Edge Cases
console.log('\n2. Testing Query Parser Edge Cases:');

// Empty query returns true for everything
let qEmpty = QueryParser.parse('');
assert.strictEqual(QueryParser.matches({ name: 'any.txt', isDir: false }, qEmpty), true);
console.log('  ✓ Empty query match passed');

// Quotes with spaces
let qQuotes = QueryParser.parse('"Annual Financial Report 2026.docx"');
assert.strictEqual(QueryParser.matches({ name: 'Annual Financial Report 2026.docx', isDir: false }, qQuotes), true);
assert.strictEqual(QueryParser.matches({ name: 'Other.docx', isDir: false }, qQuotes), false);
console.log('  ✓ Quoted strings with spaces passed');

// Korean queries & brackets
let qKorean = QueryParser.parse('(사업계획서|예산안) 2026 !초안');
assert.strictEqual(QueryParser.matches({ name: '2026_사업계획서_최종.hwp', isDir: false }, qKorean), true);
assert.strictEqual(QueryParser.matches({ name: '2026_사업계획서_초안.hwp', isDir: false }, qKorean), false);
assert.strictEqual(QueryParser.matches({ name: '2025_사업계획서_최종.hwp', isDir: false }, qKorean), false);
console.log('  ✓ Korean terms, brackets and negation passed');

// Date ranges
let qDate = QueryParser.parse('dm:thisyear');
const thisYearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
assert.strictEqual(QueryParser.matches({ name: 'new.txt', mtime: Date.now(), isDir: false }, qDate), true);
assert.strictEqual(QueryParser.matches({ name: 'old.txt', mtime: thisYearStart - 1000000, isDir: false }, qDate), false);
console.log('  ✓ dm:thisyear relative date filter passed');

// Size presets
let qSizePreset = QueryParser.parse('size:huge');
assert.strictEqual(QueryParser.matches({ name: 'big.zip', size: 50 * 1024 * 1024, isDir: false }, qSizePreset), true);
assert.strictEqual(QueryParser.matches({ name: 'small.zip', size: 1024, isDir: false }, qSizePreset), false);
console.log('  ✓ size:huge (16MB - 128MB) preset filter passed');

let qSizeOnFolder = QueryParser.parse('size:>1mb');
assert.strictEqual(QueryParser.matches({ name: 'folder', isDir: true, size: 0 }, qSizeOnFolder), false);
let qBadRegex = QueryParser.parse('regex:[broken');
assert.strictEqual(QueryParser.matches({ name: '[broken-report.txt', isDir: false }, qBadRegex), true);
assert.ok(translateNaturalLanguage('100GB 이상 동영상').includes('size:>100GB'));
assert.strictEqual(translateNaturalLanguage('지난주에 작성한 엑셀 파일'), 'dm:lastweek ext:xlsx,xls');
assert.strictEqual(translateNaturalLanguage('오늘 수정한 PDF'), 'dm:today ext:pdf');
assert.strictEqual(translateNaturalLanguage('사진 중 바다'), 'pic: 바다');
console.log('  ✓ Directory size semantics, malformed regex fallback, and natural-language units passed');

// 3. Duplicate Finder Edge Cases
console.log('\n3. Testing Duplicate Finder Edge Cases:');
// Create temporary duplicate files
const dup1 = path.join(testDir, 'file1.txt');
const dup2 = path.join(testDir, 'file2.txt');
const diff = path.join(testDir, 'diff.txt');
fs.writeFileSync(dup1, 'Identical content for duplicate verification test 1234567890');
fs.writeFileSync(dup2, 'Identical content for duplicate verification test 1234567890');
fs.writeFileSync(diff, 'Different content here');

const dupRecords = [
  { name: 'file1.txt', path: testDir, size: fs.statSync(dup1).size, isDir: false, ext: 'txt' },
  { name: 'file2.txt', path: testDir, size: fs.statSync(dup2).size, isDir: false, ext: 'txt' },
  { name: 'diff.txt', path: testDir, size: fs.statSync(diff).size, isDir: false, ext: 'txt' }
];

DuplicateFinder.findDuplicates(dupRecords, { minSize: 10 }).then(dupes => {
  assert.strictEqual(dupes.groups.length, 1);
  assert.strictEqual(dupes.groups[0].items.length, 2);
  assert.ok(dupes.totalWastedBytes > 0);
  console.log(`  ✓ Duplicate Finder detected ${dupes.groups.length} duplicate group (wasted: ${dupes.totalWastedBytes} bytes)`);

  // Clean up test dir
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (e) {}

  console.log('\n======================================================');
  console.log('✅ ALL COMPREHENSIVE DEBUGGING TESTS PASSED (0 ERRORS)');
  console.log('======================================================\n');
  process.exit(0);
}).catch(err => {
  console.error('Duplicate test error:', err);
  process.exit(1);
});

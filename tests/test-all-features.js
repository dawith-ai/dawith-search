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
const TagManager = require('../src/engine/tag-manager');
const { NativeSearchAdapter, normalizeEverythingRecord } = require('../src/engine/native-search');

console.log('🧪 Running Comprehensive Multi-Edge-Case Debugging Suite...\n');

// 1. Tag Manager Test
console.log('1. Testing Tag Manager & Starred Items:');
const testDir = path.join(os.tmpdir(), 'dawith-test-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });
const tagMgr = new TagManager(testDir);

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

// 1b. Cross-platform native adapter contracts
console.log('\n1b. Testing native backend adapters:');
const fakeEs = new NativeSearchAdapter({
  platform: 'win32',
  esPath: 'C:\\Tools\\es.exe',
  spawn: (command, args, options, callback) => callback(null, JSON.stringify([
    { name: 'Report.txt', path: 'C:\\Users\\Dawith\\Documents', size: '1,024', date_modified: '2026-10-26T10:00:00Z' }
  ]), '')
});
assert.strictEqual(fakeEs.supports('report ext:txt'), true);
assert.strictEqual(fakeEs.supports('tag:important'), false);
fakeEs.search('report', { limit: 10 }).then(result => {
  assert.strictEqual(result.supported, true);
  assert.strictEqual(result.backend, 'everything');
  assert.strictEqual(result.records[0].size, 1024);
  assert.strictEqual(result.records[0].ext, 'txt');
  console.log('  ✓ Everything JSON adapter normalization and local-only filter routing passed');
}).catch(error => {
  console.error('Native adapter test error:', error);
  process.exit(1);
});

const normalizedRecord = normalizeEverythingRecord({ path: '/Users/dawith/Documents/Report.md', size: 10 });
assert.strictEqual(normalizedRecord.name, 'Report.md');
assert.strictEqual(normalizedRecord.ext, 'md');

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

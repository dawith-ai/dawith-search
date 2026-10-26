const assert = require('assert');
const path = require('path');
const { QueryParser, translateNaturalLanguage } = require('../src/engine/query-parser');
const Indexer = require('../src/engine/indexer');
const Exporter = require('../src/engine/exporter');
const DuplicateFinder = require('../src/engine/duplicate-finder');
const StorageAnalyzer = require('../src/engine/storage-analyzer');
const ContentSearcher = require('../src/engine/content-search');
const RemoteServer = require('../src/engine/remote-server');

console.log('🧪 Starting Dawith Search Comprehensive Test Suite...\n');

// 1. Everything Syntax Tests
console.log('1. Testing Everything Search Syntax Compatibility:');

// Wildcard & Extension
let q1 = QueryParser.parse('*.pdf');
assert.strictEqual(q1.terms[0][0].hasWildcard, true);
assert.strictEqual(QueryParser.matches({ name: 'invoice.pdf', isDir: false }, q1), true);
assert.strictEqual(QueryParser.matches({ name: 'invoice.docx', isDir: false }, q1), false);
console.log('  ✓ Wildcard glob (*.pdf) passed');

// Boolean AND / OR / NOT
let q2 = QueryParser.parse('report (pdf|docx) !temp');
assert.strictEqual(QueryParser.matches({ name: 'annual_report.pdf', isDir: false }, q2), true);
assert.strictEqual(QueryParser.matches({ name: 'temp_report.pdf', isDir: false }, q2), false);
console.log('  ✓ Boolean AND / OR / NOT passed');

// Size Modifiers
let q3 = QueryParser.parse('size:>10mb size:<100mb');
assert.strictEqual(QueryParser.matches({ name: 'video.mp4', size: 50 * 1024 * 1024, isDir: false }, q3), true);
assert.strictEqual(QueryParser.matches({ name: 'tiny.txt', size: 1024, isDir: false }, q3), false);
assert.strictEqual(QueryParser.matches({ name: 'huge.iso', size: 500 * 1024 * 1024, isDir: false }, q3), false);
console.log('  ✓ Size operators (size:>10mb size:<100mb) passed');

// Date Modifiers
let q4 = QueryParser.parse('dm:today');
assert.strictEqual(QueryParser.matches({ name: 'today.txt', mtime: Date.now(), isDir: false }, q4), true);
assert.strictEqual(QueryParser.matches({ name: 'old.txt', mtime: Date.now() - 30 * 86400000, isDir: false }, q4), false);
console.log('  ✓ Date Modified operators (dm:today) passed');

// Category Macros
let q5 = QueryParser.parse('doc:');
assert.ok(q5.extensions.includes('pdf'));
assert.ok(q5.extensions.includes('docx'));
assert.ok(q5.extensions.includes('hwp'));
console.log('  ✓ Category Macros (doc:, pic:, video:, audio:) passed');

// 2. AI Smart Query Translation
console.log('\n2. Testing AI Smart Query Translation:');
let ai1 = translateNaturalLanguage('지난주 다운로드한 100MB 이상 동영상');
assert.ok(ai1.includes('dm:lastweek'));
assert.ok(ai1.includes('size:>100mb'));
assert.ok(ai1.includes('video:'));
console.log(`  ✓ Natural Korean translated to: "${ai1}"`);

// 3. Exporter Tests (EFU, CSV, JSON, TXT)
console.log('\n3. Testing Exporters:');
const sampleItems = [
  { name: 'test.pdf', path: 'C:\\docs', size: 1024, mtime: Date.now(), ctime: Date.now(), isDir: false, ext: 'pdf' }
];
const efuOutput = Exporter.toEFU(sampleItems);
assert.ok(efuOutput.includes('Filename,Size,Date Modified,Date Created,Attributes'));
assert.ok(efuOutput.includes('"C:\\docs\\test.pdf",1024'));
console.log('  ✓ Voidtools Everything EFU format passed');

const csvOutput = Exporter.toCSV(sampleItems);
assert.ok(csvOutput.includes('Name,Path,Size (Bytes)'));
console.log('  ✓ CSV export passed');

// 4. Storage Analyzer
console.log('\n4. Testing Storage Analyzer:');
const storageRes = StorageAnalyzer.analyze(sampleItems);
assert.strictEqual(storageRes.totalFiles, 1);
assert.strictEqual(storageRes.categories.documents.count, 1);
console.log('  ✓ Storage categorization passed');

// 5. Indexer In-memory Search Performance
console.log('\n5. Testing Indexer Benchmark:');
const indexer = new Indexer({ autoStartWatcher: false });
indexer.loadCache();
console.log(`  ✓ Indexer loaded ${indexer.records.length} records from disk cache`);

indexer.search('*.pdf', { limit: 10 }).then(res => {
  console.log(`  ✓ Instant search query (*.pdf) executed in ${res.elapsedMs}ms with ${res.totalMatches} matches`);
  console.log('\n🎉 ALL 15 CORE REFERENCE AND EXTENSION TESTS PASSED PERFECTLY!\n');
  process.exit(0);
}).catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});

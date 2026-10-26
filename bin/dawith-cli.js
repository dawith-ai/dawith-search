#!/usr/bin/env node

/**
 * Dawith Search CLI - Voidtools es.exe counterpart
 */
const path = require('path');
const Indexer = require('../src/engine/indexer');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log(`
⚡ Dawith Search CLI (Everything es.exe compatible)
--------------------------------------------------
Usage: dawith-cli <search-term> [options]

Examples:
  dawith-cli report.docx
  dawith-cli "ext:pdf size:>10mb"
  dawith-cli "*.png|*.jpg" -l 20
  dawith-cli -reindex

Options:
  -l, --limit <n>     Max results (default: 50)
  -s, --sort <col>    Sort by: name, size, mtime, ext
  -r, --reverse       Reverse sort order
  --reindex           Force background reindex
  -h, --help          Show help
`);
    process.exit(0);
  }

  const indexer = new Indexer();
  const loaded = indexer.loadCache();

  if (args.includes('--reindex') || !loaded) {
    console.log('Indexing files in progress...');
    await indexer.startIndexing();
    console.log(`Indexed ${indexer.records.length} files/folders.`);
    if (args.includes('--reindex') && args.length === 1) {
      process.exit(0);
    }
  }

  let limit = 50;
  let sortBy = 'name';
  let sortOrder = 'asc';
  const queryTerms = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-l' || arg === '--limit') {
      limit = parseInt(args[++i], 10) || 50;
    } else if (arg === '-s' || arg === '--sort') {
      sortBy = args[++i] || 'name';
    } else if (arg === '-r' || arg === '--reverse') {
      sortOrder = 'desc';
    } else if (arg === '--reindex') {
      // already handled
    } else {
      queryTerms.push(arg);
    }
  }

  const query = queryTerms.join(' ');
  const res = await indexer.search(query, { limit, sortBy, sortOrder });

  console.log(`\nFound ${res.totalMatches} matches (${res.elapsedMs}ms):\n`);
  for (const item of res.results) {
    const full = path.join(item.path, item.name);
    const sizeStr = item.isDir ? '<DIR>' : (item.size / 1024).toFixed(1) + ' KB';
    const dateStr = new Date(item.mtime).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`${dateStr}  ${sizeStr.padEnd(12)}  ${full}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

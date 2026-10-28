const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  maxFiles: 5000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxSourceBytes: 2 * 1024 * 1024,
  maxHashBytes: 128 * 1024 * 1024
});

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next'
]);

const SOURCE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.json', '.css', '.scss', '.vue', '.svelte'
]);

const HASH_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.json', '.css', '.scss', '.vue', '.svelte',
  '.md', '.txt', '.csv', '.xml', '.yaml', '.yml', '.h', '.hpp', '.c', '.cc', '.cpp', '.swift', '.go', '.py',
  '.java', '.kt', '.rs', '.sql', '.ini', '.toml'
]);

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function fileExtension(filePath) {
  return path.extname(filePath).toLowerCase() || '[no extension]';
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableId(prefix, value) {
  return `${prefix}_${hashText(value).slice(0, 24)}`;
}

function addCount(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function safeResolveImport(sourcePath, specifier, filesByPath) {
  if (!specifier || (!specifier.startsWith('.') && !specifier.startsWith('/'))) return null;
  const base = specifier.startsWith('/')
    ? specifier.slice(1)
    : normalizeRelativePath(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [base];
  if (!path.posix.extname(base)) {
    for (const extension of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json']) candidates.push(`${base}${extension}`);
    for (const extension of ['.js', '.ts', '.json']) candidates.push(`${base}/index${extension}`);
  }
  return candidates.find(candidate => filesByPath.has(candidate)) || null;
}

function collectImports(source) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) imports.push(match[1]);
  }
  return [...new Set(imports)];
}

function collectBoundaryObservations(source, relativePath) {
  const observations = [];
  const rules = [
    ['electron.browser-window', /\b(?:new\s+)?BrowserWindow\b/, 'Electron BrowserWindow construction candidate'],
    ['electron.ipc-main', /\bipcMain\s*\.\s*(?:handle|on|once)\s*\(/, 'Electron main-process IPC registration candidate'],
    ['electron.ipc-renderer', /\bipcRenderer\s*\.\s*(?:invoke|send|sendSync|on|once)\s*\(/, 'Electron renderer IPC operation candidate'],
    ['electron.context-bridge', /\bcontextBridge\s*\.\s*exposeInMainWorld\s*\(/, 'Electron contextBridge exposure candidate'],
    ['electron.preload', /\bpreload\b/, 'Electron preload configuration or reference candidate'],
    ['electron.shell', /\bshell\s*\.\s*(?:openExternal|showItemInFolder|openPath)\s*\(/, 'Electron shell operation candidate'],
    ['filesystem.read', /\b(?:readFile|readFileSync|createReadStream|readdir|readdirSync|opendir)\s*\(/, 'Filesystem read candidate'],
    ['filesystem.write', /\b(?:writeFile|writeFileSync|createWriteStream|rename|unlink|rm)\s*\(/, 'Filesystem mutation candidate'],
    ['network.request', /\b(?:fetch|WebSocket|https?\.request)\s*\(/, 'Network request candidate']
  ];
  for (const [kind, pattern, description] of rules) {
    if (pattern.test(source)) {
      observations.push({
        id: stableId('obs', `${relativePath}:${kind}`),
        kind,
        description,
        state: 'observed',
        confidence: 'static-candidate',
        location: { path: relativePath }
      });
    }
  }
  return observations;
}

async function hashFile(filePath, size, maxHashBytes) {
  if (size > maxHashBytes) return { sha256: null, status: 'skipped-large' };
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), status: 'complete' };
}

async function readSource(filePath, size, maxSourceBytes) {
  if (size > maxSourceBytes) return { source: null, status: 'skipped-large' };
  try {
    const buffer = await fs.promises.readFile(filePath);
    if (buffer.includes(0)) return { source: null, status: 'binary' };
    return { source: buffer.toString('utf8'), status: 'complete' };
  } catch (error) {
    return { source: null, status: 'unreadable', error: error.message };
  }
}

async function walk(rootPath, options, state, relativeDirectory = '') {
  if (state.files.length >= options.maxFiles || state.totalBytes >= options.maxTotalBytes) return;
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(rootPath, relativeDirectory), { withFileTypes: true });
  } catch (error) {
    state.unknowns.push({
      id: stableId('unknown', `${relativeDirectory}:readdir:${error.code || error.message}`),
      kind: 'directory-read',
      state: 'unknown',
      path: normalizeRelativePath(relativeDirectory || '.'),
      reason: error.code || error.message
    });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const entry of entries) {
    if (state.files.length >= options.maxFiles || state.totalBytes >= options.maxTotalBytes) break;
    const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
        state.omitted.push({ path: relativePath, reason: 'excluded-directory' });
        continue;
      }
      await walk(rootPath, options, state, relativePath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      state.unknowns.push({
        id: stableId('unknown', `${relativePath}:symlink`),
        kind: 'symbolic-link',
        state: 'unknown',
        path: relativePath,
        reason: 'symlink-not-followed'
      });
      continue;
    }
    if (!entry.isFile()) continue;

    let stat;
    try {
      stat = await fs.promises.stat(path.join(rootPath, relativePath));
    } catch (error) {
      state.unknowns.push({
        id: stableId('unknown', `${relativePath}:stat:${error.code || error.message}`),
        kind: 'file-stat',
        state: 'unknown',
        path: relativePath,
        reason: error.code || error.message
      });
      continue;
    }
    if (state.totalBytes + stat.size > options.maxTotalBytes) {
      state.omitted.push({ path: relativePath, reason: 'total-byte-budget' });
      break;
    }

    const absolutePath = path.join(rootPath, relativePath);
    const extension = fileExtension(relativePath);
    const hash = HASH_EXTENSIONS.has(extension) ? await hashFile(absolutePath, stat.size, options.maxHashBytes) : { sha256: null, status: 'not-requested' };
    const file = {
      id: stableId('file', `${relativePath}:${stat.size}:${stat.mtimeMs}`),
      path: relativePath,
      extension,
      size: stat.size,
      mtime: stat.mtimeMs,
      sha256: hash.sha256,
      hashStatus: hash.status,
      kind: SOURCE_EXTENSIONS.has(extension) ? 'source' : 'artifact'
    };
    state.files.push(file);
    state.filesByPath.set(relativePath, file);
    state.totalBytes += stat.size;
    addCount(state.extensions, extension);

    if (SOURCE_EXTENSIONS.has(extension)) {
      const read = await readSource(absolutePath, stat.size, options.maxSourceBytes);
      if (read.source !== null) state.sources.set(relativePath, read.source);
      else state.unknowns.push({
        id: stableId('unknown', `${relativePath}:source:${read.status}`),
        kind: 'source-analysis',
        state: 'unknown',
        path: relativePath,
        reason: read.status
      });
    }
  }
}

function buildReport(rootPath, state, options, startedAt) {
  const relationships = [];
  const evidence = [];
  const boundaryObservations = [];
  let parsedSources = 0;

  for (const [sourcePath, source] of state.sources.entries()) {
    parsedSources += 1;
    const imports = collectImports(source);
    for (const specifier of imports) {
      const targetPath = safeResolveImport(sourcePath, specifier, state.filesByPath);
      relationships.push({
        id: stableId('rel', `${sourcePath}:${specifier}:${targetPath || 'unresolved'}`),
        relation: 'imports',
        source: sourcePath,
        specifier,
        target: targetPath,
        resolution: targetPath ? 'resolved' : 'unknown',
        state: targetPath ? 'observed' : 'unknown'
      });
      if (!targetPath) state.unknowns.push({
        id: stableId('unknown', `${sourcePath}:import:${specifier}`),
        kind: 'import-resolution',
        state: 'unknown',
        path: sourcePath,
        value: specifier,
        reason: 'dynamic-or-outside-inventory'
      });
    }
    const observations = collectBoundaryObservations(source, sourcePath);
    boundaryObservations.push(...observations);
    evidence.push(...observations);
  }

  for (const file of state.files) {
    evidence.push({
      id: stableId('evidence', `${file.path}:${file.sha256 || file.mtime}`),
      kind: 'file-inventory',
      state: 'observed',
      confidence: file.sha256 ? 'exact' : 'metadata-only',
      location: { path: file.path },
      value: { size: file.size, extension: file.extension, sha256: file.sha256 }
    });
  }

  const durationMs = Date.now() - startedAt;
  const reachedFileLimit = state.files.length >= options.maxFiles;
  const reachedByteLimit = state.totalBytes >= options.maxTotalBytes;
  const coverageStatus = state.omitted.length || state.unknowns.length || reachedFileLimit || reachedByteLimit ? 'partial' : 'complete';
  const sortedFiles = [...state.files].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = sortedFiles.map(file => `${file.path}\0${file.size}\0${file.mtime}\0${file.sha256 || ''}`).join('\n');

  const report = {
    schemaVersion: 1,
    analyzer: {
      name: 'Dawith Search local evidence analyzer',
      version: '1',
      inspiration: 'REA evidence-first application reconstruction',
      execution: 'local-only, deterministic, no AI, no network'
    },
    subject: {
      path: rootPath,
      format: 'directory',
      sha256: hashText(manifest)
    },
    createdAt: new Date().toISOString(),
    durationMs,
    coverage: {
      status: coverageStatus,
      examinedFiles: state.files.length,
      parsedSources,
      omittedFiles: state.omitted.length,
      unknowns: state.unknowns.length,
      limits: {
        maxFiles: options.maxFiles,
        maxTotalBytes: options.maxTotalBytes,
        maxSourceBytes: options.maxSourceBytes,
        maxHashBytes: options.maxHashBytes
      }
    },
    summary: {
      files: state.files.length,
      sourceFiles: state.files.filter(file => file.kind === 'source').length,
      artifactFiles: state.files.filter(file => file.kind === 'artifact').length,
      totalBytes: state.totalBytes,
      extensions: state.extensions,
      imports: relationships.length,
      resolvedImports: relationships.filter(item => item.resolution === 'resolved').length,
      unknownImports: relationships.filter(item => item.resolution === 'unknown').length,
      boundaries: boundaryObservations.length,
      electronBoundaries: boundaryObservations.filter(item => item.kind.startsWith('electron.')).length
    },
    inventory: sortedFiles,
    relationships: relationships.sort((a, b) => a.source.localeCompare(b.source) || a.specifier.localeCompare(b.specifier)),
    observations: evidence,
    unknowns: state.unknowns,
    limitations: [
      'Static source observations do not prove runtime execution or authorization enforcement.',
      'Dynamic imports, generated code, obfuscated paths, and external dependencies may remain unknown.',
      'Excluded directories and files outside the configured budgets are recorded as omitted, not absent.',
      'Binary files are inventoried and hashed only when their extension is in the bounded hash set; no native disassembler is invoked.'
    ]
  };
  return report;
}

async function analyzePath(inputPath, options = {}) {
  const rootPath = path.resolve(String(inputPath || ''));
  const stat = await fs.promises.stat(rootPath);
  if (!stat.isDirectory()) throw new Error('Evidence analysis requires a folder.');
  const mergedOptions = { ...DEFAULTS, ...options };
  for (const key of ['maxFiles', 'maxTotalBytes', 'maxSourceBytes', 'maxHashBytes']) {
    if (!Number.isInteger(mergedOptions[key]) || mergedOptions[key] <= 0) throw new Error(`Invalid analysis limit: ${key}`);
  }
  const startedAt = Date.now();
  const state = {
    files: [],
    filesByPath: new Map(),
    sources: new Map(),
    unknowns: [],
    omitted: [],
    extensions: {},
    totalBytes: 0
  };
  await walk(rootPath, mergedOptions, state);
  return buildReport(rootPath, state, mergedOptions, startedAt);
}

module.exports = { analyzePath, DEFAULTS };

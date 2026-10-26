#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const sourceRoots = ['bin', 'src', 'tests', 'scripts'];
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(entryPath);
    else if (entry.name.endsWith('.js')) files.push(entryPath);
  }
}

for (const sourceRoot of sourceRoots) collect(path.join(root, sourceRoot));

for (const filePath of files) {
  execFileSync(process.execPath, ['--check', filePath], { stdio: 'inherit' });
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);

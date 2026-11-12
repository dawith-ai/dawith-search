#!/usr/bin/env node
// Writes the license texts of every Rust crate linked into the shipped
// binaries (the Tauri app on each desktop target, and goz/gozd on Windows)
// to licenses/. Run after changing Cargo.lock:
//   node scripts/generate-third-party-licenses.js
// Build-time-only crates (build scripts, proc macros) are left out because
// they are not part of the distributed binaries.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'licenses');

const PROJECTS = [
  {
    name: 'Dawith Search (Tauri app)',
    manifest: 'src-tauri/Cargo.toml',
    targets: ['x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu'],
    out: 'THIRD_PARTY_LICENSES-rust.txt',
  },
  {
    name: 'goz / gozd (bundled Windows search helper)',
    manifest: 'native/goz/Cargo.toml',
    targets: ['x86_64-pc-windows-msvc'],
    out: 'THIRD_PARTY_LICENSES-goz.txt',
  },
];

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;

// Standard texts for crates that declare a license without shipping it.
const STANDARD_TEXTS = {
  MIT: `MIT License

Copyright (c) <HOLDERS>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  'BSD-3-Clause': `BSD 3-Clause License

Copyright (c) <HOLDERS>

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};

// Pick MIT when it is offered; otherwise the single declared license.
function chooseStandardLicense(expression) {
  const ids = String(expression || '').split(/\s+(?:OR|AND)\s+|[()/]/).map(id => id.trim()).filter(Boolean);
  const chosen = ids.includes('MIT') ? 'MIT' : ids[0];
  if (!STANDARD_TEXTS[chosen]) throw new Error(`No standard text for license "${expression}"; add it to STANDARD_TEXTS.`);
  return chosen;
}

function cargo(args) {
  return execFileSync('cargo', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function linkedPackages(project) {
  const linked = new Set();
  for (const target of project.targets) {
    const tree = cargo(['tree', '--manifest-path', project.manifest, '--workspace', '-e', 'normal,no-proc-macro',
      '--target', target, '--prefix', 'none', '-f', '{p}']);
    for (const line of tree.split(/\r?\n/)) {
      const match = line.trim().match(/^(\S+) v(\S+)/);
      if (match) linked.add(`${match[1]}@${match[2]}`);
    }
  }
  return linked;
}

function licenseFiles(dir) {
  const found = [];
  const walk = (current, depth) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && LICENSE_FILE.test(entry.name)) found.push(full);
      else if (entry.isDirectory() && depth === 0 && /^(licen[cs]es?|LICENSES)$/i.test(entry.name)) walk(full, 1);
    }
  };
  walk(dir, 0);
  return found.sort();
}

function generate(project) {
  const metadata = JSON.parse(cargo(['metadata', '--format-version', '1', '--manifest-path', project.manifest]));
  const workspace = new Set(metadata.workspace_members);
  const linked = linkedPackages(project);
  const packages = metadata.packages
    .filter(pkg => linked.has(`${pkg.name}@${pkg.version}`) && !workspace.has(pkg.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const texts = new Map(); // hash -> { id, text, users }
  const entries = [];
  const missing = [];
  for (const pkg of packages) {
    const dir = path.dirname(pkg.manifest_path);
    const refs = [];
    let files = licenseFiles(dir);
    // Crates from a git repository often keep the license at the repo root.
    for (let up = path.dirname(dir); !files.length && pkg.source && pkg.source.startsWith('git+') && /checkouts/.test(up); up = path.dirname(up)) {
      files = licenseFiles(up);
      if (fs.existsSync(path.join(up, '.git'))) break;
    }
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
      if (!text) continue;
      const hash = crypto.createHash('sha256').update(text).digest('hex');
      if (!texts.has(hash)) texts.set(hash, { id: `L${texts.size + 1}`, text, users: [] });
      const record = texts.get(hash);
      record.users.push(`${pkg.name} ${pkg.version}`);
      refs.push(`${record.id} (${path.relative(dir, file).replace(/\\/g, '/')})`);
    }
    if (!refs.length) missing.push(pkg);
    const source = pkg.source && pkg.source.startsWith('registry+')
      ? `https://crates.io/crates/${pkg.name}/${pkg.version}`
      : (pkg.repository || pkg.source || '');
    entries.push([
      `${pkg.name} ${pkg.version}`,
      `  License: ${pkg.license || pkg.license_file || 'not declared'}`,
      pkg.authors && pkg.authors.length ? `  Authors: ${pkg.authors.join(', ')}` : null,
      source ? `  Source: ${source}` : null,
      pkg.repository && pkg.repository !== source ? `  Repository: ${pkg.repository}` : null,
      `  License text: ${refs.length ? refs.join(', ') : 'none shipped in the crate; the standard text of the license above applies (see the end of this file)'}`,
    ].filter(Boolean).join('\n'));
  }

  const lines = [
    `Third-party licenses: ${project.name}`,
    '',
    'Every crate below is compiled into the distributed binaries. Each one is used',
    'unmodified, exactly as published at the listed source. Generated by',
    'scripts/generate-third-party-licenses.js from the versions locked in',
    `${path.dirname(project.manifest).replace(/\\/g, '/')}/Cargo.lock for: ${project.targets.join(', ')}.`,
    '',
    `Crates: ${packages.length}`,
    '',
    '='.repeat(78),
    'PART 1. CRATES',
    '='.repeat(78),
    '',
    entries.join('\n\n'),
    '',
    '='.repeat(78),
    'PART 2. LICENSE TEXTS (identical texts are printed once)',
    '='.repeat(78),
  ];
  for (const record of texts.values()) {
    lines.push('', '-'.repeat(78), `[${record.id}] used by: ${record.users.join(', ')}`, '-'.repeat(78), '', record.text);
  }
  if (missing.length) {
    lines.push('', '='.repeat(78), 'PART 3. CRATES THAT SHIP NO LICENSE FILE', '='.repeat(78), '',
      'These crates declare a license in Cargo.toml but include no license text.',
      'Where several licenses are offered, Dawith Search uses the crate under the',
      'one named below. The standard text is reproduced with the crate authors as',
      'copyright holders.');
    for (const pkg of missing) {
      const chosen = chooseStandardLicense(pkg.license);
      const holders = (pkg.authors && pkg.authors.length ? pkg.authors.join(', ') : `the ${pkg.name} authors`).replace(/\s*<[^>]*>/g, '');
      lines.push('', '-'.repeat(78), `${pkg.name} ${pkg.version} (declared: ${pkg.license}; used under: ${chosen})`, '-'.repeat(78), '',
        STANDARD_TEXTS[chosen].replace('<HOLDERS>', holders));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, project.out), lines.join('\n') + '\n');
  return { out: project.out, crates: packages.length, texts: texts.size, missing: missing.map(pkg => `${pkg.name} ${pkg.version} (${pkg.license})`) };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const project of PROJECTS) {
  const result = generate(project);
  console.log(`${result.out}: ${result.crates} crates, ${result.texts} distinct license texts`);
  if (result.missing.length) console.log(`  no license file: ${result.missing.join('; ')}`);
}

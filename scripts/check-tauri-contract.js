const fs = require('fs');

const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
const bridge = fs.readFileSync('src/renderer/tauri-bridge.js', 'utf8');
const rust = fs.readFileSync('src-tauri/src/main.rs', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

if (config.build?.frontendDist !== '../src/renderer') {
  throw new Error('Tauri frontendDist must point to the existing renderer.');
}
if (config.app?.withGlobalTauri !== true) {
  throw new Error('Tauri global API must be enabled for the renderer bridge.');
}
if (!cargo.includes('tauri = { version = "2"')) {
  throw new Error('Tauri Rust dependency is not pinned to major version 2.');
}
if (!packageJson.devDependencies?.['@tauri-apps/cli']) {
  throw new Error('Tauri CLI is missing from devDependencies.');
}

const invokedCommands = [...bridge.matchAll(/invoke\('([^']+)'/g)].map(match => match[1]);
const handlerBlock = rust.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] || '';
const registeredCommands = [...handlerBlock.matchAll(/\b([a-z][a-z0-9_]*)\s*,?/g)].map(match => match[1]);
const missingCommands = [...new Set(invokedCommands)].filter(name => !registeredCommands.includes(name));
if (missingCommands.length) {
  throw new Error(`Tauri bridge commands are not registered: ${missingCommands.join(', ')}`);
}

for (const command of ['search', 'get_config', 'save_config', 'choose_root', 'open_file', 'open_folder', 'reindex']) {
  if (!invokedCommands.includes(command) || !registeredCommands.includes(command)) {
    throw new Error(`Required Tauri core command is missing: ${command}`);
  }
}

if (!fs.existsSync('src/renderer/tauri-bridge.js')) {
  throw new Error('Tauri renderer bridge is missing.');
}

console.log(`Tauri contract passed (${new Set(invokedCommands).size} bridge commands, ${registeredCommands.length} registered commands).`);

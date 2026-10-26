const fs = require('fs');

const html = fs.readFileSync('src/renderer/index.html', 'utf8');
const app = fs.readFileSync('src/renderer/app.js', 'utf8');
const preload = fs.readFileSync('src/main/preload.js', 'utf8');

const htmlIds = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
if (duplicateIds.length) {
  throw new Error(`Duplicate renderer IDs: ${duplicateIds.join(', ')}`);
}

const referencedIds = [...app.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !htmlIds.includes(id));
if (missingIds.length) {
  throw new Error(`Renderer references missing IDs: ${missingIds.join(', ')}`);
}

const apiBody = preload.match(/exposeInMainWorld\(['"]dawithAPI['"],\s*\{([\s\S]*?)\n\}\);/);
if (!apiBody) throw new Error('Could not locate dawithAPI preload contract.');
const exposedApi = new Set([...apiBody[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map(match => match[1]));
const referencedApi = [...app.matchAll(/window\.dawithAPI\.([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
const missingApi = [...new Set(referencedApi)].filter(name => !exposedApi.has(name));
if (missingApi.length) {
  throw new Error(`Renderer references missing preload APIs: ${missingApi.join(', ')}`);
}

let depth = 0;
for (const token of html.matchAll(/<div\b|<\/div>/g)) {
  depth += token[0] === '<div' ? 1 : -1;
  if (depth < 0) throw new Error(`Unexpected closing div near character ${token.index}`);
}
if (depth !== 0) throw new Error(`Unbalanced renderer divs: depth ${depth}`);

console.log(`Renderer contract passed (${new Set(referencedIds).size} IDs, ${new Set(referencedApi).size} APIs).`);

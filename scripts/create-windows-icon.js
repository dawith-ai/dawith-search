const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '..', 'src', 'assets', 'icon.png');
const targetPath = path.join(__dirname, '..', 'src', 'assets', 'icon.ico');
const png = fs.readFileSync(sourcePath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
  throw new Error(`Windows icon source is not a PNG: ${sourcePath}`);
}

// Windows Vista and later accept PNG-compressed images inside ICO files.
// Keeping the original Dawith CI artwork intact avoids the washed-out
// Electron placeholder icon that appeared when the PNG was auto-converted.
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // 256px is represented by zero in ICO.
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(header.length + entry.length, 12);

fs.writeFileSync(targetPath, Buffer.concat([header, entry, png]));
console.log(`Created ${targetPath} (${png.length} byte PNG payload)`);

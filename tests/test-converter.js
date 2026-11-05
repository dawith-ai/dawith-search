const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const Converter = require('../src/engine/converter');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dawith-converter-'));
  const imagePath = path.join(root, '기관-보고서.png');
  const secondImagePath = path.join(root, '기관-사진.png');
  const firstPdfPath = path.join(root, '첫번째.pdf');
  const secondPdfPath = path.join(root, '두번째.pdf');
  try {
    // 1x1 PNG fixtures keep the regression test deterministic and offline.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(imagePath, png);
    fs.writeFileSync(secondImagePath, png);

    const imageOptions = Converter.getConversionOptions([imagePath]);
    assert.ok(imageOptions.some(option => option.id === 'images-to-pdf'));
    const imageOutputs = await Converter.convertFiles([imagePath], 'images-to-pdf', root);
    assert.strictEqual(imageOutputs.length, 1);
    assert.ok(fs.existsSync(imageOutputs[0]));

    const mergedInputs = [];
    for (const name of ['첫번째.pdf', '두번째.pdf']) {
      const document = await PDFDocument.create();
      document.addPage([200, 200]);
      const filePath = path.join(root, name);
      fs.writeFileSync(filePath, await document.save());
      mergedInputs.push(filePath);
    }
    const merged = await Converter.convertFiles(mergedInputs, 'merge-pdf', root);
    const mergedDocument = await PDFDocument.load(await fs.promises.readFile(merged[0]));
    assert.strictEqual(mergedDocument.getPageCount(), 2);

    const split = await Converter.convertFiles([merged[0]], 'split-pdf', root);
    assert.strictEqual(split.length, 2);
    console.log('File conversion tests passed (image→PDF, PDF merge, PDF split).');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

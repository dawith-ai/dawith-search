const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'hwp', 'hwpx']);

function extension(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function stem(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function uniqueOutput(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const directory = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext = path.extname(filePath);
  for (let index = 2; index < 10000; index += 1) {
    const candidate = path.join(directory, `${base} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('변환 결과 파일 이름을 만들 수 없습니다.');
}

function findCommand(names) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    try {
      const command = os.platform() === 'win32' ? 'where.exe' : 'which';
      const output = execFileSync(command, [name], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim();
      if (output) return output.split(/\r?\n/)[0];
    } catch (error) {
      // Try the next supported converter.
    }
  }
  return null;
}

function getAvailableImageTool() {
  if (os.platform() === 'darwin') return findCommand('sips');
  if (os.platform() === 'win32') return findCommand(['magick.exe', 'convert.exe']);
  return findCommand(['magick', 'convert']);
}

function getAvailableOfficeTool() {
  return findCommand(os.platform() === 'win32'
    ? ['soffice.exe', 'libreoffice.exe']
    : ['soffice', 'libreoffice']);
}

function getConversionOptions(filePaths) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const extensions = files.map(extension);
  const options = [];
  const allImages = files.length > 0 && extensions.every(item => IMAGE_EXTENSIONS.has(item));
  const allPdfs = files.length > 0 && extensions.every(item => item === 'pdf');
  const imageTool = getAvailableImageTool();
  const officeTool = getAvailableOfficeTool();

  if (allImages) {
    options.push({ id: 'images-to-pdf', label: files.length > 1 ? '이미지를 PDF 하나로 묶기' : 'PDF로 변환', detail: '원본은 유지하고 같은 폴더에 새 파일을 만듭니다.' });
    if (files.length === 1 && imageTool) {
      options.push({ id: 'image-to-png', label: 'PNG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
      options.push({ id: 'image-to-jpg', label: 'JPG로 변환', detail: '설치된 OS 이미지 변환 도구를 사용합니다.' });
    }
  }

  if (allPdfs) {
    if (files.length > 1) options.push({ id: 'merge-pdf', label: 'PDF 하나로 합치기', detail: `${files.length}개 PDF를 선택 순서대로 합칩니다.` });
    if (files.length === 1) options.push({ id: 'split-pdf', label: 'PDF 페이지별로 나누기', detail: '페이지마다 별도 PDF를 만듭니다.' });
  }

  if (files.length === 1 && OFFICE_EXTENSIONS.has(extensions[0]) && officeTool) {
    options.push({ id: 'office-to-pdf', label: 'PDF로 변환', detail: '설치된 LibreOffice/지원 변환기를 사용합니다.' });
  }

  return options;
}

async function imageToPdf(filePaths, destinationDir) {
  const document = await PDFDocument.create();
  for (const filePath of filePaths) {
    const bytes = await fs.promises.readFile(filePath);
    const ext = extension(filePath);
    const image = ext === 'png' ? await document.embedPng(bytes) : await document.embedJpg(bytes);
    const page = document.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const outputName = filePaths.length === 1 ? `${stem(filePaths[0])}.pdf` : `${stem(filePaths[0])} 외 ${filePaths.length - 1}개.pdf`;
  const outputPath = uniqueOutput(path.join(destinationDir, outputName));
  await fs.promises.writeFile(outputPath, await document.save());
  return [outputPath];
}

async function mergePdfs(filePaths, destinationDir) {
  const output = await PDFDocument.create();
  for (const filePath of filePaths) {
    const source = await PDFDocument.load(await fs.promises.readFile(filePath));
    const pages = await output.copyPages(source, source.getPageIndices());
    pages.forEach(page => output.addPage(page));
  }
  const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePaths[0])} 외 ${filePaths.length - 1}개.pdf`));
  await fs.promises.writeFile(outputPath, await output.save());
  return [outputPath];
}

async function splitPdf(filePath, destinationDir) {
  const source = await PDFDocument.load(await fs.promises.readFile(filePath));
  const outputs = [];
  for (const [index, sourceIndex] of source.getPageIndices().entries()) {
    const pageDocument = await PDFDocument.create();
    const [page] = await pageDocument.copyPages(source, [sourceIndex]);
    pageDocument.addPage(page);
    const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePath)}-${String(index + 1).padStart(2, '0')}.pdf`));
    await fs.promises.writeFile(outputPath, await pageDocument.save());
    outputs.push(outputPath);
  }
  return outputs;
}

function convertImage(filePath, targetExtension, destinationDir) {
  const tool = getAvailableImageTool();
  if (!tool) throw new Error('이미지 변환 도구를 찾지 못했습니다.');
  const outputPath = uniqueOutput(path.join(destinationDir, `${stem(filePath)}.${targetExtension}`));
  const args = os.platform() === 'darwin'
    ? ['-s', 'format', targetExtension === 'jpg' ? 'jpeg' : targetExtension, filePath, '--out', outputPath]
    : [filePath, outputPath];
  return new Promise((resolve, reject) => {
    execFile(tool, args, { windowsHide: true, timeout: 120000 }, error => {
      if (error) reject(new Error(`이미지 변환에 실패했습니다: ${error.message}`));
      else resolve([outputPath]);
    });
  });
}

function convertOfficeToPdf(filePath, destinationDir) {
  const tool = getAvailableOfficeTool();
  if (!tool) throw new Error('LibreOffice 또는 호환 Office 변환기를 찾지 못했습니다.');
  return new Promise((resolve, reject) => {
    execFile(tool, ['--headless', '--convert-to', 'pdf', '--outdir', destinationDir, filePath], {
      windowsHide: true,
      timeout: 180000
    }, error => {
      if (error) {
        reject(new Error(`문서 변환에 실패했습니다: ${error.message}`));
        return;
      }
      const outputPath = path.join(destinationDir, `${stem(filePath)}.pdf`);
      if (!fs.existsSync(outputPath)) {
        reject(new Error('변환기는 실행됐지만 PDF 결과를 찾지 못했습니다.'));
        return;
      }
      resolve([outputPath]);
    });
  });
}

async function convertFiles(filePaths, operation, destinationDir) {
  const files = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  if (!files.length) throw new Error('변환할 파일이 없습니다.');
  const targetDir = destinationDir || path.dirname(files[0]);
  await fs.promises.mkdir(targetDir, { recursive: false }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });

  if (operation === 'images-to-pdf') return imageToPdf(files, targetDir);
  if (operation === 'merge-pdf') return mergePdfs(files, targetDir);
  if (operation === 'split-pdf') return splitPdf(files[0], targetDir);
  if (operation === 'image-to-png') return convertImage(files[0], 'png', targetDir);
  if (operation === 'image-to-jpg') return convertImage(files[0], 'jpg', targetDir);
  if (operation === 'office-to-pdf') return convertOfficeToPdf(files[0], targetDir);
  throw new Error('지원하지 않는 변환 작업입니다.');
}

module.exports = {
  IMAGE_EXTENSIONS,
  getConversionOptions,
  convertFiles
};

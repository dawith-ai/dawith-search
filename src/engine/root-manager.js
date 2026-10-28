const fs = require('fs');
const os = require('os');
const path = require('path');

function isUncPath(value) {
  return /^\\\\[^\\/]+[\\/][^\\/]+/.test(String(value || '').trim());
}

function isWindowsDrivePath(value) {
  return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function isMountedMacPath(value) {
  return /^\/Volumes(?:\/|$)/.test(String(value || '').trim());
}

function classifyRoot(value) {
  const input = String(value || '').trim();
  if (isUncPath(input)) return { kind: 'windows-unc', label: 'Windows 공유폴더', path: input };
  if (isWindowsDrivePath(input)) return { kind: 'windows-drive', label: 'Windows 네트워크 드라이브', path: input };
  if (isMountedMacPath(input)) return { kind: 'mac-mounted-share', label: 'macOS 연결된 공유폴더', path: input };
  if (path.isAbsolute(input)) return { kind: 'local-folder', label: '로컬 폴더', path: path.resolve(input) };
  return { kind: 'invalid', label: '알 수 없음', path: input };
}

async function inspectRoot(input) {
  const classification = classifyRoot(input);
  if (classification.kind === 'invalid') {
    return { success: false, error: '절대 경로를 입력하세요. 예: \\\\server\\share 또는 /Volumes/공유폴더' };
  }

  if ((classification.kind === 'windows-unc' || classification.kind === 'windows-drive') && os.platform() !== 'win32') {
    return {
      success: false,
      kind: classification.kind,
      path: classification.path,
      error: 'Windows 공유 경로는 Windows에서 실행할 때 연결할 수 있습니다. macOS에서는 공유폴더를 Finder에서 연결한 뒤 /Volumes 경로를 입력하세요.'
    };
  }

  try {
    const stat = await fs.promises.stat(classification.path);
    if (!stat.isDirectory()) {
      return { success: false, kind: classification.kind, path: classification.path, error: '선택한 경로가 폴더가 아닙니다.' };
    }
    return {
      success: true,
      kind: classification.kind,
      label: classification.label,
      path: classification.path,
      reachable: true
    };
  } catch (error) {
    return {
      success: false,
      kind: classification.kind,
      path: classification.path,
      error: `폴더에 연결할 수 없습니다. 공유 권한·VPN·네트워크 연결을 확인하세요. (${error.code || error.message})`
    };
  }
}

module.exports = {
  classifyRoot,
  inspectRoot,
  isUncPath,
  isWindowsDrivePath,
  isMountedMacPath
};

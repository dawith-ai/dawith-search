# Dawith Search

macOS와 Windows에서 Everything 스타일의 빠른 파일 검색을 제공하는 Electron 데스크톱 앱입니다. 검색 문법, 실시간 색인, Quick Look, 태그, 중복 분석을 하나의 로컬 도구로 묶었습니다.

사회복지기관·학교·소규모 사무실에서 반복하는 문서 찾기, 최근 수정 파일 확인, 통계 파일 모아보기, 기관 폴더별 검색, 저장 검색 공유를 빠르게 처리하도록 설계했습니다. 검색과 자연어 해석은 외부 AI 없이 로컬 규칙과 색인으로 동작합니다.

## 검색 백엔드

- Windows: `es.exe`를 찾으면 실행 중인 Voidtools Everything의 네이티브 인덱스를 사용합니다. `DAWITH_ES_PATH`로 경로를 직접 지정할 수 있습니다. Everything과 `es.exe`는 앱에 포함하지 않습니다.
- macOS: 단순 파일명 검색은 Spotlight `mdfind`를 사용하고, `ext:`, `size:`, `dm:`, `content:`, 태그 같은 복합 검색은 앱의 로컬 인덱서로 처리합니다.
- 기타 플랫폼: `fdir` 기반 초기 색인과 `chokidar` 기반 변경 감시를 사용합니다.

네이티브 백엔드가 없거나 해당 쿼리를 지원하지 않으면 자동으로 로컬 색인으로 폴백합니다. 검색 속도는 OS 인덱스 상태, 지정한 루트, 파일 수에 따라 달라집니다.

### Windows 공유 폴더

설정 → 색인할 폴더 → 검색 폴더 추가에서 `\\서버\공유폴더` 같은 UNC 경로를 선택하면 접근 가능한 Windows 네트워크 공유도 색인·검색할 수 있습니다. 공유 폴더가 Everything 색인에 없더라도 Dawith Search의 로컬 색인이 결과를 보완합니다. 공유 권한이 있는 동일한 Windows 사용자로 앱을 실행해야 하며, 연결이 끊긴 공유는 다시 연결한 뒤 설정에서 전체 재색인을 실행하세요. 매핑 드라이브는 관리자 권한 앱과 일반 앱의 드라이브 매핑이 다를 수 있으므로 UNC 경로 사용을 권장합니다.

## 지원 기능

- Everything 계열 문법: AND, OR(`|`), NOT(`!`/`-`), 와일드카드, `regex:`, `ext:`, `size:`, `dm:`, `dc:`, `content:`, `tag:`, `starred:`
- 한국어 자연어 검색 보조: “지난주 100GB 이상 동영상”, “어제 작성한 엑셀 파일” 등
- 이미지·텍스트·오디오·비디오 Quick Look
- CSV, TXT, JSON, EFU 내보내기
- 별표·가상 태그, 안전한 휴지통 삭제, 이름 변경
- 저장된 검색(Bookmarks), 최근 검색 기록, 기관 업무용 빠른 검색, 폴더 범위 검색
- 기관별 검색 폴더 추가, 로컬 개인정보 보호 안내, 키보드 중심 작업 흐름
- 스토리지 분류, 대용량 파일, SHA-256 기반 중복 분석
- CLI와 QR 기반 모바일 원격 검색

## 개발

```bash
git clone https://github.com/dawith-ai/dawith-search.git
cd dawith-search
npm ci
npm start
```

`npm start`는 개발 모드 데스크톱 앱을 실행합니다. GitHub 저장소 자체는 웹 앱 주소가 아니라 소스 코드 주소입니다. 설치 파일은 [앱 다운로드(Releases)](https://github.com/dawith-ai/dawith-search/releases)에서 받습니다.

### 현재 공개 앱 주소

- [설치 안내 홈페이지](https://dawith-search-guide.vercel.app/)
- [최신 릴리스 페이지](https://github.com/dawith-ai/dawith-search/releases/latest)
- [macOS universal (Apple Silicon + Intel) DMG](https://github.com/dawith-ai/dawith-search/releases/latest/download/Dawith.Search-1.0.4-universal.dmg)
- [Windows x64 Portable](https://github.com/dawith-ai/dawith-search/releases/latest/download/DawithSearch-1.0.4-portable.exe)
- [REA 기반 구조·증거 분석](docs/REA-INTEGRATION.md)

릴리스 페이지에서 운영체제에 맞는 파일을 선택하세요. macOS universal은 Apple Silicon과 Intel Mac을 하나의 앱으로 지원합니다. Windows에서는 Everything이 설치되어 있으면 `es.exe` 네이티브 검색을 사용하고, 없으면 Dawith Search 로컬 색인으로 동작합니다.

## 공식 참고 주소

- [Voidtools 공식 홈페이지](https://www.voidtools.com/ko-kr/)
- [Everything 다운로드](https://www.voidtools.com/ko-kr/downloads/)
- [Everything 공식 도움말](https://www.voidtools.com/support/everything/)

공유 폴더 경계와 Everything 미색인 UNC 폴더 보완 경로는 `npm test`의 Windows UNC 회귀 케이스로 검증합니다. 실제 사내 공유 서버 접근 여부는 해당 Windows 계정의 네트워크 권한과 연결 상태에 따라 달라집니다.

검증 명령:

```bash
npm run check
npm audit --audit-level=high
```

패키징:

```bash
npm run build:win   # Windows portable EXE
npm run build:win:arm64 # Windows ARM64 portable EXE
npm run build:mac   # macOS universal DMG + ZIP (Apple Silicon + Intel)
```

## CLI

```bash
dawith-cli report.docx
dawith-cli "ext:pdf size:>10mb" -l 20
dawith-cli "*.png|*.jpg" -s size -r
```

## 오픈소스 고지

- [fdir](https://github.com/thecodrr/fdir) — MIT, 초기 디렉터리 크롤링
- [chokidar](https://github.com/paulmillr/chokidar) — MIT, 실시간 파일 감시
- [Electron](https://github.com/electron/electron) 및 [electron-builder](https://github.com/electron-userland/electron-builder)

## 참고한 오픈소스 설계

코드를 무단 복사하지 않고 공개 기능·구조·사용 흐름을 비교해 이 프로젝트에 맞게 다시 구현했습니다.

- [Sift File Search](https://github.com/MalyStern/sift-file-search) — MIT, 크로스플랫폼 로컬 검색, 저장 검색, 최근 검색, 키보드 우선 흐름 참고
- [File-Find](https://github.com/Pixel-Master/File-Find) — GPL-3.0, 검색 캐시, 제외 목록, 로컬 전용 운영과 권한 안내 참고
- [FilesMate](https://github.com/DieDust/FilesMate) — 공개 저장소, 폴더 범위·즐겨찾기·미리보기·작업대 중심의 파일 업무 흐름 참고
- [fdir](https://github.com/thecodrr/fdir) — MIT, 초기 디렉터리 크롤링에 실제 사용
- [chokidar](https://github.com/paulmillr/chokidar) — MIT, 파일 변경 감시에 실제 사용

각 프로젝트의 라이선스와 원문은 링크에서 확인할 수 있습니다. 앱에 실제로 포함한 라이브러리는 위의 `fdir`, `chokidar`, Electron 계열이며, Sift/File-Find/FilesMate는 설계 비교 자료입니다.

Everything/ES는 Voidtools의 별도 소프트웨어이며, 공식 CLI 사용 조건은 [Voidtools 문서](https://www.voidtools.com/en-us/support/everything/command_line_interface/)를 따릅니다.

## 라이선스

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

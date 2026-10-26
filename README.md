# Dawith Search

macOS와 Windows에서 Everything 스타일의 빠른 파일 검색을 제공하는 Electron 데스크톱 앱입니다. 검색 문법, 실시간 색인, Quick Look, 태그, 중복 분석을 하나의 로컬 도구로 묶었습니다.

## 검색 백엔드

- Windows: `es.exe`를 찾으면 실행 중인 Voidtools Everything의 네이티브 인덱스를 사용합니다. `DAWITH_ES_PATH`로 경로를 직접 지정할 수 있습니다. Everything과 `es.exe`는 앱에 포함하지 않습니다.
- macOS: 단순 파일명 검색은 Spotlight `mdfind`를 사용하고, `ext:`, `size:`, `dm:`, `content:`, 태그 같은 복합 검색은 앱의 로컬 인덱서로 처리합니다.
- 기타 플랫폼: `fdir` 기반 초기 색인과 `chokidar` 기반 변경 감시를 사용합니다.

네이티브 백엔드가 없거나 해당 쿼리를 지원하지 않으면 자동으로 로컬 색인으로 폴백합니다. 검색 속도는 OS 인덱스 상태, 지정한 루트, 파일 수에 따라 달라집니다.

## 지원 기능

- Everything 계열 문법: AND, OR(`|`), NOT(`!`/`-`), 와일드카드, `regex:`, `ext:`, `size:`, `dm:`, `dc:`, `content:`, `tag:`, `starred:`
- 한국어 자연어 검색 보조: “지난주 100GB 이상 동영상”, “어제 작성한 엑셀 파일” 등
- 이미지·텍스트·오디오·비디오 Quick Look
- CSV, TXT, JSON, EFU 내보내기
- 별표·가상 태그, 안전한 휴지통 삭제, 이름 변경
- 스토리지 분류, 대용량 파일, SHA-256 기반 중복 분석
- CLI와 QR 기반 모바일 원격 검색

## 개발

```bash
git clone https://github.com/dawith-ai/dawith-search.git
cd dawith-search
npm ci
npm start
```

검증 명령:

```bash
npm run check
npm audit --audit-level=high
```

패키징:

```bash
npm run build:win   # Windows portable EXE
npm run build:mac   # macOS DMG + ZIP
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

Everything/ES는 Voidtools의 별도 소프트웨어이며, 공식 CLI 사용 조건은 [Voidtools 문서](https://www.voidtools.com/en-us/support/everything/command_line_interface/)를 따릅니다.

## 라이선스

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

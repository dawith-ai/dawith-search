# Dawith Search

macOS와 Windows에서 빠른 파일 검색을 제공하는 Dawith 데스크톱 앱입니다. 기본 경량 런타임은 Tauri/Rust이며, Electron 런타임은 기능 비교·롤백용으로 보존합니다. 검색 문법, 로컬 색인, Quick Look, 태그, 중복 분석을 하나의 로컬 도구로 묶었습니다.

사회복지기관·학교·소규모 사무실에서 반복하는 문서 찾기, 최근 수정 파일 확인, 통계 파일 모아보기, 기관 폴더별 검색, 저장 검색 공유를 빠르게 처리하도록 설계했습니다. 기본값은 내 PC 로컬 전체 자동 검색이며, 공유폴더·외부 경로만 직접 추가합니다. 검색과 자연어 해석은 외부 AI 없이 로컬 규칙과 색인으로 동작합니다.

## 검색 백엔드

- Windows (1.3.0부터): Dawith 자체 색인("Dawith 색인")으로 검색합니다. 파일 이름·폴더·크기·날짜를 담은 압축된 목록을 메모리에 두고 `rayon`으로 모든 CPU 코어에서 검색하며, 파일 약 46만 개인 PC에서 검색 1회에 0.01–0.05초 정도 걸립니다.
  - 첫 실행: 파일 목록을 만드는 데 C 드라이브 기준 1분 정도 걸리고(네트워크 공유폴더가 있으면 더 오래), 찾은 파일부터 바로 검색됩니다. 첫 실행 안내 창과 제목 표시줄 진행 막대(%)로 진행 상황을 보여 줍니다.
  - 다음 실행: 목록을 `~/.dawith-search/index-v2.bin`에 저장해 두므로 켜자마자 검색할 수 있고, 백그라운드에서 폴더를 다시 읽어 새 목록으로 교체합니다. 앱을 켜 둔 동안에는 파일 생성·삭제·이름 변경을 운영체제 알림으로 받아 1초 안팎에 색인에 반영합니다(`notify`).
  - Everything 연결(선택): 기본으로 사용하지 않습니다. 고급 사용자는 `~/.dawith-search/config.json`에 `"useEverything": true`를 넣어 실행 중인 Voidtools Everything(SDK IPC bridge)과 `goz`/`gozd` NTFS 엔진을 켤 수 있습니다(설정 화면은 아직 없음). 두 도우미는 설치본에 선택 구성 요소로 들어 있으며, 앱은 사용자의 `Everything.exe`를 복사하거나 재배포하지 않습니다. `DAWITH_EVERYTHING_IPC_PATH`/`DAWITH_GOZ_PATH`로 경로를 직접 지정할 수 있습니다.
- macOS: 단순 파일명 검색은 Spotlight `mdfind`를 사용하고, `ext:`, `size:`, `dm:`, `content:`, 태그 같은 복합 검색은 앱의 로컬 인덱서로 처리합니다.
- 기타 플랫폼: Node.js 파일시스템 기반 초기 색인과 `chokidar` 기반 변경 감시를 사용합니다. 접근할 수 없는 폴더는 건너뛰고 검색 가능한 파일은 계속 색인합니다.

`useEverything`을 켰더라도 Everything·goz가 준비되지 않았거나 해당 쿼리를 지원하지 않으면 Dawith 색인으로 검색합니다. Windows Tauri 패키지는 `build:tauri` 단계에서 IPC bridge와 `goz/gozd`를 함께 빌드하며, `gozd` 서비스 설치는 설정 화면에서 사용자가 명시적으로 승인할 때만 UAC를 요청합니다. 검색 속도는 OS 인덱스 상태, 지정한 루트, 파일 수에 따라 달라집니다.

### 속도 벤치마크

Windows에서 `gozd` 서비스를 설치한 뒤 실제 사무실 PC의 검색 지연을 측정할 수 있습니다.

```bash
npm run benchmark:search -- 보고서
```

이 명령은 Electron 런타임의 네이티브 어댑터(`src/engine/native-search.js`)를 대상으로 2회 워밍업 후 20회 검색의 최소값·p50·p95·최대값과 사용 백엔드를 출력합니다. `goz`/Everything이 연결되지 않은 경우에는 fallback 측정임을 명시하며, 그 숫자를 native 엔진 성능으로 오인하지 않습니다. 앱 입력은 120ms debounce와 최신 요청 우선 처리를 사용해 타이핑 중 중복 IPC와 오래된 결과 렌더링을 줄입니다.

### 기본 로컬 검색과 외부 폴더

앱을 처음 실행하면 macOS·Linux에서는 사용자 홈 폴더 전체를, Windows에서는 감지된 로컬 드라이브 전체를 자동 검색합니다. Desktop·Documents처럼 폴더를 하나씩 지정할 필요가 없습니다. 외부 디스크나 공유폴더는 설정에서 직접 추가한 경로만 색인합니다.

### 패치 업데이트

앱은 실행 후 GitHub 최신 릴리스를 확인하고 새 패치가 있으면 상단에 `vX.Y.Z 업데이트` 버튼을 표시합니다. Windows는 최신 portable EXE를 내려받아 앱을 재실행하고, macOS는 universal DMG를 열어 설치를 이어갑니다. 설치 파일에 GitHub SHA-256 digest가 제공되면 다운로드 후 무결성을 확인합니다.

### Windows 공유 폴더

설정 → 색인할 폴더 → 검색 폴더 추가에서 `\\서버\공유폴더` 같은 UNC 경로를 선택하면 접근 가능한 Windows 네트워크 공유도 색인·검색할 수 있습니다. 추가한 공유 폴더는 Dawith 색인에 함께 담겨 로컬 파일과 같이 검색됩니다. 공유 권한이 있는 동일한 Windows 사용자로 앱을 실행해야 하며, 연결이 끊긴 공유는 다시 연결한 뒤 설정에서 전체 재색인을 실행하세요. 매핑 드라이브는 관리자 권한 앱과 일반 앱의 드라이브 매핑이 다를 수 있으므로 UNC 경로 사용을 권장합니다.

## 지원 기능

- Everything 계열 문법: AND, OR(`|`), NOT(`!`/`-`), 와일드카드, `regex:`, `ext:`, `size:`, `dm:`, `dc:`, `content:`, `tag:`, `starred:`
- 한국어 자연어 검색 보조: “지난주 100GB 이상 동영상”, “어제 작성한 엑셀 파일” 등
- 이미지·텍스트·오디오·비디오 Quick Look
- CSV, TXT, JSON, EFU 내보내기
- 검색 결과 파일 변환: PNG/JPG→PDF, PDF 병합·분할, Windows 설치 Office·한글 또는 LibreOffice 기반 Office→PDF
- 검색 결과에서 `변환` 버튼·우클릭 메뉴·Shift 드래그로 변환 흐름 진입 (원본 보존)
- Windows 암호화·암호입력 파일은 변환 전에 명확한 안내를 표시하고 변환하지 않음
- 첫 실행에서 간편 모드와 다양한 기능 모드를 선택하고 설정에서 변경 가능
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

`npm start`는 Electron legacy 개발 모드이고, `npm run start:tauri`는 경량 Tauri 개발 모드입니다. GitHub 저장소 자체는 웹 앱 주소가 아니라 소스 코드 주소입니다. 설치 파일은 [앱 다운로드(Releases)](https://github.com/dawith-ai/dawith-search/releases)에서 받습니다.

### 현재 공개 앱 주소

- [설치 안내 홈페이지](https://dawith-ai.github.io/dawith-search/) (GitHub Pages, 푸시하면 자동 배포) · [Vercel 사본](https://dawith-search-guide.vercel.app/)
- [최신 릴리스 페이지](https://github.com/dawith-ai/dawith-search/releases/tag/v1.3.3)
- [Google Drive 최신 배포 폴더 (Windows · macOS)](https://drive.google.com/drive/folders/1MAfWcXfVfIS_ZwIC1BGLFTr1xhkCwGvH)
- [macOS Tauri 경량 universal DMG (Intel + Apple Silicon)](https://drive.google.com/file/d/12qTLAt2_KEXCIc9a-wQWa4Cn--bziVCF/view?usp=drivesdk)
- [Windows Tauri 경량 설치기 (x64)](https://drive.google.com/file/d/1okn_RvzNyDjpkO6Zo_Of5dasEQL2z9YH/view?usp=drivesdk)
- [기존 Electron 릴리스 파일](https://github.com/dawith-ai/dawith-search/releases/latest) — Tauri 기능 검증 전 비교·롤백용
- [REA 기반 구조·증거 분석](docs/REA-INTEGRATION.md)
- [오픈소스 기능 조사·업그레이드 로드맵](docs/OPEN-SOURCE-ROADMAP.md)

릴리스 페이지에서 운영체제에 맞는 파일을 선택하세요. macOS universal은 Apple Silicon과 Intel Mac을 하나의 앱으로 지원합니다. Windows에서는 Everything을 따로 설치할 필요가 없으며, 1.3.0부터 Dawith 자체 색인으로 검색합니다. Everything 연결은 `useEverything` 설정을 켠 경우에만 쓰며, 이때도 Everything 본체가 백그라운드에서 실행 중이어야 하고 IPC를 제공하지 않는 설치 형태에서는 사용할 수 없습니다.

## 공식 참고 주소

- [Voidtools 공식 홈페이지](https://www.voidtools.com/ko-kr/)
- [goz 소스와 라이선스](https://github.com/mustafaahci/goz)
- [Everything 공식 SDK](https://www.voidtools.com/en-us/support/everything/sdk/)
- [Everything SDK IPC API](https://www.voidtools.com/support/everything/sdk/ipc/)
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
npm run build:tauri # Tauri 경량 패키지 (Rust toolchain 필요)
```

## CLI

```bash
dawith-cli report.docx
dawith-cli "ext:pdf size:>10mb" -l 20
dawith-cli "*.png|*.jpg" -s size -r
```

## 오픈소스 고지

- [chokidar](https://github.com/paulmillr/chokidar) — MIT, 실시간 파일 감시
- [Electron](https://github.com/electron/electron) 및 [electron-builder](https://github.com/electron-userland/electron-builder)

## 참고한 오픈소스 설계

코드를 무단 복사하지 않고 공개 기능·구조·사용 흐름을 비교해 이 프로젝트에 맞게 다시 구현했습니다.

- [Sift File Search](https://github.com/MalyStern/sift-file-search) — MIT, 크로스플랫폼 로컬 검색, 저장 검색, 최근 검색, 키보드 우선 흐름 참고
- [File-Find](https://github.com/Pixel-Master/File-Find) — GPL-3.0, 검색 캐시, 제외 목록, 로컬 전용 운영과 권한 안내 참고
- [FilesMate](https://github.com/DieDust/FilesMate) — 공개 저장소, 폴더 범위·즐겨찾기·미리보기·작업대 중심의 파일 업무 흐름 참고
- [chokidar](https://github.com/paulmillr/chokidar) — MIT, 파일 변경 감시에 실제 사용

각 프로젝트의 라이선스와 원문은 링크에서 확인할 수 있습니다. 앱에 실제로 포함한 라이브러리는 위의 `chokidar`, Electron 계열이며, Sift/File-Find/FilesMate는 설계 비교 자료입니다.

Everything/ES는 Voidtools의 별도 소프트웨어이며(Dawith Search 1.3.0은 기본으로 사용하지 않음), 공식 CLI 사용 조건은 [Voidtools 문서](https://www.voidtools.com/en-us/support/everything/command_line_interface/)를 따릅니다. Dawith Search의 독립 Windows 엔진 소스는 `native/goz`에 MIT 고지와 함께 포함되어 있습니다. `gozd.exe install`은 관리자 권한이 필요한 명시적 작업이라 앱이 몰래 실행하지 않습니다.

## 라이선스

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

## 상표와 라이선스 고지

본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. 한글은 한글과컴퓨터의 상표이며, Dawith Search는 한글과컴퓨터와 관계없는 별도 프로젝트입니다.

Everything은 voidtools의 제품이자 상표이며, Dawith Search는 voidtools와 관계없는 별도 프로젝트입니다. Dawith Search는 Everything을 포함하거나 재배포하지 않고, `useEverything`을 켠 경우에만 사용자가 따로 설치한 Everything과 공식 SDK(MIT)로 통신합니다. 설치본에는 `licenses` 폴더에 Dawith Search, Everything SDK, goz, Rust 라이브러리의 라이선스 전문이 함께 들어 있습니다. 전체 목록은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.

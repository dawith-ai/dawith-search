# Architecture: Dawith Search

## 0. Links

- Product and operations: [README.md](./README.md), [OPERATIONS.md](./OPERATIONS.md)
- Runtime entry (current lightweight target): `src-tauri/src/main.rs`
- Renderer bridge: `src/renderer/tauri-bridge.js`
- Legacy rollback runtime: `src/main/main.js` + `src/main/preload.js`

## 1. System Context

```mermaid
flowchart LR
  User[기관 담당자] --> App[Dawith Search 데스크톱 앱]
  App --> Local[로컬 파일 시스템]
  App --> OSIndex[macOS Spotlight / Windows Everything]
  App -. 선택적 LAN .-> Phone[같은 네트워크 모바일 브라우저]
```

사용자 파일과 검색 인덱스는 로컬에 보관한다. 외부 AI와 외부 검색 API는 사용하지 않는다.

## 2. Container View

| 컨테이너 | 책임 | 기술 |
| --- | --- | --- |
| Tauri native core | 창 수명주기, 경로 선택·검증, 파일 작업, 검색 IPC | Tauri 2.x, Rust |
| Electron legacy core | 기능 완전성 비교·롤백용 기존 런타임 | Electron 45.x, Node.js |
| Search backend | 플랫폼별 빠른 검색과 제한된 fallback | macOS `mdfind`, Windows Everything SDK IPC, Rust `walkdir` |
| Renderer | 검색 작업대·기관 업무 UX·안내 | HTML/CSS/브라우저 JS |
| Remote server | 토큰으로 보호된 선택적 모바일 검색 | Express 4.x, Node HTTP |

## 3. Component View

- `Indexer`: 검색 루트, 색인, 파일 감시, 네이티브 검색 결과의 루트 제한
- `QueryParser`: Everything 계열 문법과 로컬 규칙 기반 자연어 보조
- `NativeSearchAdapter`: Spotlight/Everything adapter와 레코드 정규화
- `storage-utils`: 원자적 JSON 저장, 백업 복구, 로컬 권한 설정
- `RemoteServer`: 토큰 인증, 요청 제한, 검색 루트 realpath allowlist
- `main.js`: single-instance, crash logging, IPC 경로 경계
- `src-tauri/src/main.rs`: 경량 런타임의 검색·경로·파일 작업 명령과 OS adapter
- `src/renderer/tauri-bridge.js`: 기존 renderer의 핵심 API를 Tauri command로 연결
- `renderer/app.js`: 검색 작업대, 저장 검색, Quick Look, 안전한 파일 작업

## 4. Data Design

로컬 데이터 디렉터리 `~/.dawith-search`에 다음 파일을 둔다.

| 파일 | 내용 | 복구 |
| --- | --- | --- |
| `config.json` | 검색 루트·제외 규칙·백엔드 선택 | `config.json.bak` |
| `index-cache.json` | 색인된 파일 레코드 | `index-cache.json.bak` 또는 전체 재색인 |
| `metadata.json` | 태그·별표 | `metadata.json.bak` |
| `bookmarks.json` | 저장 검색 | `bookmarks.json.bak` |
| `search-history.json` | 최근 검색 | `search-history.json.bak` |

모든 JSON 쓰기는 임시 파일 → rename 순서로 수행한다. 파일에는 운영체제별로 가능한 최소 권한을 적용한다.

## 5. Interface Design

Renderer와 런타임 사이 IPC는 `preload.js`(Electron) 또는 `tauri-bridge.js`(Tauri)에서 명시적으로 노출한다. 파일 관련 Tauri 명령은 설정된 검색 루트 allowlist를 통과한 경로만 처리한다. Tauri 경량 단계에서는 검색·설정·서치 경로 추가·열기·복사·재색인을 우선 제공하고, 저장 검색·변환·분석·원격 서버는 Electron legacy와의 기능 차이를 회귀 목록으로 관리한다.

모바일 원격 서버의 공개 표면:

- `GET /?token=...`: 토큰 확인 후 HttpOnly 쿠키 발급
- `GET /api/search?q=...`: 인증된 로컬 색인 검색
- `GET /api/download?path=...`: 허용 루트 내부의 일반 파일만 다운로드
- `GET /api/preview?path=...`: 허용 루트 내부의 일반 파일만 미리보기

## 6. NFR Realization

- 성능: Tauri 시스템 WebView + Rust native index → `walkdir` fallback, 검색 결과 상한, 디바운스 검색
- 보안: context isolation, nodeIntegration 비활성화, CSP, token auth, path allowlist
- 개인정보: 외부 AI/API 미사용, 로컬 저장소, 원격 기능 명시적 시작
- 복구: atomic write, backup recovery, reindex, crash log
- 접근성: 키보드 탐색, visible focus, reduced motion, 명확한 empty/error state

## 7. Product ADRs

### ADR-001 — 플랫폼별 native adapter + 공통 local fallback

- Status: Accepted
- Context: macOS와 Windows의 검색 인덱스 계약이 다르다.
- Decision: 단순 쿼리는 OS adapter를 사용하되, Everything 전용 조건·태그·본문·범위 조건은 공통 local parser/indexer를 사용한다.
- Alternatives rejected: 플랫폼별 기능을 완전히 분리하면 UX와 회귀 검증이 달라진다.
- Consequences: 백엔드 상태를 UI에 표시하고, native 결과도 검색 루트로 제한한다.

### ADR-002 — 선택적 LAN 원격 기능은 ephemeral token으로 보호

- Status: Accepted
- Context: 모바일 공유는 편리하지만 인증 없는 파일 다운로드는 기관 환경에서 허용할 수 없다.
- Decision: 시작마다 랜덤 토큰을 발급하고 HttpOnly/SameSite 쿠키와 root realpath allowlist를 적용한다.
- Alternatives rejected: IP allowlist만으로는 동일 네트워크의 다른 사용자를 구분하지 못한다.
- Consequences: QR URL을 공유받은 사용자만 30분 세션 동안 접근한다.

### ADR-003 — Electron 대신 Tauri를 경량 운영 런타임으로 채택

- Status: Accepted (migration in progress)
- Context: Electron runtime이 Windows portable 약 105MB, macOS universal 약 203MB를 차지해 검색 도구의 핵심 가치인 경량성과 맞지 않는다.
- Decision: 기존 renderer를 유지하고 Tauri 2 Rust core를 새 기본 패키지 경로로 추가한다. Windows에서는 포함된 Everything SDK IPC helper를 우선 호출하고, macOS에서는 Spotlight를 사용하며, 실패 시 Rust filesystem fallback을 사용한다. Electron은 기능 비교·롤백용으로 당분간 보존한다.
- Alternatives rejected: Electron 최적화만으로는 Chromium runtime 크기를 제거할 수 없다. REA는 검색 런타임이 아닌 분석·역공학 참고 도구이므로 실행 엔진으로 포함하지 않는다.
- Consequences: Tauri core가 먼저 제공하는 기능과 Electron legacy의 전체 기능 사이 차이를 명시하고, 실제 CI 패키지 크기를 측정한 뒤 배포 파일을 교체한다.

## 8. Deployment View

```mermaid
flowchart TB
  Release[GitHub Release] --> Mac[macOS universal DMG/ZIP]
  Release --> Win[Windows x64 portable EXE]
  Mac --> LocalApp[사용자 로컬 앱]
  Win --> LocalApp
  LocalApp --> UserData[사용자 로컬 데이터 디렉터리]
```

릴리스는 GitHub Actions의 세 OS 검증과 Electron/Tauri macOS·Windows 패키징을 통과해야 한다. Tauri 산출물은 `src-tauri/target/release/bundle`에서 실제 크기와 실행 파일 존재를 확인한 뒤 배포한다. 코드 서명 인증서가 없는 빌드는 첫 실행 보안 안내를 제공한다.

## 9. Risks & Tech Debt

- 코드 서명·자동 업데이트는 인증서와 배포 정책이 필요하다.
- 대규모 기관 공유 드라이브는 OS 권한과 색인 시간에 따라 별도 부하 테스트가 필요하다.
- 원격 서버는 LAN 전용 보조 기능이며 중앙 인증·감사 로그가 필요한 조직은 사용하지 않아야 한다.
- Windows의 Everything native backend는 Voidtools 설치·서비스 상태에 의존하며 미설치 시 local fallback을 사용한다.

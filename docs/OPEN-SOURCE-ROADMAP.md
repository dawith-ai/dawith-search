# 오픈소스 기능 조사와 반영 범위

2026-10-28 기준으로 GitHub의 크로스플랫폼 파일 검색 프로젝트와 Windows 공유폴더 구현을 조사했다. 라이선스와 현재 Electron 구조를 함께 확인해, 코드를 무단 복사하지 않고 호환 가능한 동작만 반영한다.

## 이번에 반영한 기능

- 설정에서 로컬·연결된 폴더를 선택하는 기존 흐름을 유지한다.
- `공유 경로 직접 입력`으로 Windows UNC(`\\server\\share`), Windows 드라이브·공유 경로(`Z:\\agency`), macOS 마운트 공유폴더(`/Volumes/share`)를 입력한다.
- 입력 시 폴더 존재·디렉터리 여부·현재 계정 접근 권한을 확인하고, 실패하면 검색 루트에 저장하지 않는다.
- 저장된 위치를 로컬/Windows 공유/네트워크 드라이브/macOS 공유폴더로 구분하고 개별 제거할 수 있다.
- 루트 추가 후 즉시 재색인하고, UNC 경계·경로 정규화·권한 오류를 테스트한다.

## 조사한 후보와 판단

| 프로젝트 | 확인된 장점 | 반영 판단 |
| --- | --- | --- |
| [MalyStern/sift-file-search](https://github.com/MalyStern/sift-file-search) (MIT) | Electron 기반, Windows/macOS/Linux, fuzzy name search, content grep, saved search, watcher | 현재 앱의 query parser·content search·저장 검색과 겹친다. fuzzy ranking 개선 후보로 기록하고, 전체 클론은 하지 않는다. |
| [TeodorZlatanov/allsee](https://github.com/TeodorZlatanov/allsee) (MIT) | 스냅샷/WAL, ignore 파일, 설정 가능한 테마, 자동 watcher | WAL·스냅샷은 대규모 기관 폴더에서 유용하다. 현재 JSON atomic cache가 있으므로 다음 단계에서 장애 복구 테스트를 확장한다. Tauri/Rust 엔진 교체는 범위 밖이다. |
| [SysAdminDoc/QuickFind](https://github.com/SysAdminDoc/QuickFind) (MIT) | SMB/UNC 색인, 네트워크 자격 증명 경계, junction loop guard, SQLite FTS5, USN Journal, 진단 | Windows 전용 MFT/USN 구현은 macOS와 공통 패키지로 묶지 않는다. 대신 이번 작업에서 안전한 UNC 입력·권한 확인·재색인 흐름을 먼저 반영했다. 자격 증명은 앱에 저장하지 않는다. |
| [Pixel-Master/File-Find](https://github.com/Pixel-Master/File-Find) | 비교 검색, 중복 검색, 필터 저장, 캐시 재사용, Full Disk Access 안내 | 기존 중복 분석·저장 검색·Quick Look과 기능이 겹친다. macOS 권한 안내만 설치 문서에 유지한다. |

## 다음 구현 후보

1. fuzzy filename ranking과 검색 결과의 매칭 구간 표시
2. 루트별 색인 상태·마지막 성공 시각·권한 오류 표시
3. 루트별 `.dawithignore` 패턴과 junction/symlink loop guard
4. 큰 기관 폴더를 위한 worker 기반 본문 색인과 resumable checkpoint
5. Windows에서만 선택적으로 USN Journal 가속을 제공하고, 실패 시 현재 recursive scan으로 안전하게 fallback

네트워크 자격 증명, SMB 비밀번호, 외부 클라우드 검색은 개인정보·운영 보안 경계 때문에 기본 기능으로 추가하지 않는다.

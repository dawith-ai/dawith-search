# REA 기반 구조·증거 분석

## 확인한 레퍼런스

2026-10-28에 [morluto/rea](https://github.com/morluto/rea) 최신 shallow clone을 별도 임시 디렉터리에서 분석했다.

- 기준 커밋: `ad7d4c1f4dd9cbd93229ee330e66c7a522e723e6`
- REA 버전: `rea-agents 6.8.0`
- 분석 명령: `npx -y rea-agents@6.8.0 analyze-javascript-application <repo> --detail summary --evidence_output <bundle> --source-paths-json <paths> --json`
- 전체 저장소 5,803개 파일 분석은 REA 결과 용량 제한으로 실패했다. 실패를 성공으로 취급하지 않고, 핵심 코드 35개를 source-path로 제한해 재실행했다.
- 제한 분석은 종료 코드 0으로 완료됐고, Evidence bundle과 summary를 생성했다.
- 결과에서 확인한 수치: 전체 인벤토리 5,895개, 정적 파일 그래프 노드 11,750개, 관계 12,521개, 선택 소스 35개, source-selection 밖 파일 5,768개.

## 반영한 핵심 기능

REA의 native Hopper/Ghidra/IDA provider나 MCP agent orchestration을 데스크톱 검색 앱에 그대로 복사하지 않았다. 이 앱의 목표는 기관 PC의 로컬 파일 검색이며, 외부 AI·네트워크·사용자 파일 업로드 없이 실사용 가능한 범위로 다음의 핵심 계약을 반영했다.

| REA 핵심 계약 | Dawith Search 구현 |
| --- | --- |
| Artifact inventory | 검색 폴더의 파일·확장자·크기·수정일을 안정적인 상대 경로로 수집 |
| Artifact identity | 예산 범위 안에서 파일 SHA-256, 전체 manifest SHA-256 제공 |
| Application graph | JS/TS/HTML/JSON 등 소스의 정적 import·require 관계와 resolved/unknown 상태 제공 |
| Boundary observations | Electron `ipcMain`, `ipcRenderer`, `contextBridge`, `BrowserWindow`, preload 및 파일/네트워크 후보 관찰 |
| Evidence | 파일·관계·경계마다 observed 상태와 위치를 기록 |
| Unknowns | 동적 import, 심볼릭 링크, 읽기 실패, 큰 소스, 제외 디렉터리를 absent가 아닌 unknown/omitted로 기록 |
| Coverage | complete/partial, 검사 파일 수, 제한값, 미확인 수를 함께 제공 |
| Evidence delivery | 앱에서 보고서를 JSON으로 저장해 재검토 가능 |

## 사용 방법

1. 설정에서 분석할 폴더를 검색 폴더로 추가한다. Windows 공유 폴더는 `\\server\\share` 경로도 기존 Everything 백엔드와 동일하게 검색 루트로 등록할 수 있다.
2. 상단 `도구 → 구조·증거 분석`을 연다.
3. 폴더를 선택하고 `분석 시작`을 누른다.
4. 파일 수, source/import 관계, Electron 경계, 미확인 항목을 확인한다.
5. 필요하면 `JSON 저장`으로 증거 보고서를 보관한다.

## 정확성 경계

- 정적 후보는 프로그램 실행이나 실제 권한 검사를 증명하지 않는다.
- `node_modules`, `.git`, `dist`, `build`, `coverage`, 캐시 디렉터리는 기본 제외되며 제외 사실이 기록된다.
- 기본 예산은 5,000개 파일, 512 MiB 총 크기, 파일당 2 MiB 소스 분석, 파일당 128 MiB 해시다.
- native disassembler, browser capture, MCP server, runtime trace는 현재 Dawith Search의 범위에 포함하지 않았다. 이 기능들은 별도 분석 제품의 provider 의존성과 운영 권한이 필요하며, 검색 앱에 무단 실행·외부 전송 경로를 만들지 않기 위해 추가하지 않았다.
- 실행 완료의 증거는 `npm run lint`, `npm test`, Electron E2E와 실제 REA CLI 종료 코드 및 생성된 Evidence bundle이다.

# Dawith Search 7차 운영 기준

이 문서는 “실행되는 데모”와 “기관에서 계속 사용하는 데스크톱 도구”를 구분하는 운영 기준이다. 각 단계는 구현·검증 증거를 함께 남긴다.

## 1. 설치·시작 게이트

- macOS: Apple Silicon + Intel universal DMG/ZIP
- Windows: 일반 PC용 x64 portable EXE, Windows ARM64 별도 빌드 명령 제공
- 단일 인스턴스 잠금, 준비 완료 후 창 표시, 렌더러 로드 실패 대화상자, crash.log 기록
- 첫 실행 시 기본 검색 루트가 없으면 사용자 홈을 안전하게 대체 루트로 사용

검증: `npm run build:mac`, `npm run build:win`, Electron 프로세스 smoke test

## 2. 검색 품질 게이트

- Everything `es.exe`가 있으면 Windows 네이티브 검색 사용
- Windows 설정에서 추가한 UNC 공유 폴더(`\\server\share`)는 접근 가능한 경우 자체 색인으로 읽고, Everything 미색인 결과도 보완
- macOS 단순 검색은 Spotlight, 복합 조건은 로컬 인덱서 사용
- 네이티브 검색 결과도 설정된 검색 루트 밖으로 노출하지 않음
- Everything 문법, 한국어 조건, 날짜·크기·본문·중복·태그 조건 회귀 테스트

검증: `npm test`의 parser/native/scope 회귀 케이스

## 3. 데이터 무결성 게이트

- 설정·캐시·즐겨찾기·검색 기록·태그를 임시 파일에 쓴 뒤 원자적으로 교체
- 이전 파일을 `.bak`으로 보존하고 기본 파일이 깨지면 백업에서 복구
- macOS/Linux 저장 디렉터리 `0700`, 저장 파일 `0600` 적용
- Windows에서는 OS 권한 모델을 따르며 파일 쓰기 실패를 조용히 무시하지 않음

검증: `tests/test-operations.js`의 atomic write/backup recovery 케이스

## 4. 개인정보·보안 게이트

- 외부 AI·외부 검색 서버를 사용하지 않음
- 모바일 원격 검색은 매번 랜덤 토큰을 발급하고 HttpOnly/SameSite 쿠키로 인증
- 원격 검색은 로컬 인덱서만 사용하며 요청 수를 제한
- 다운로드·미리보기는 설정된 검색 루트와 실제 realpath 내부의 파일만 허용
- Electron IPC의 파일 열기·삭제·미리보기·이름 변경도 설정 루트 밖 경로를 거부
- 삭제는 영구 삭제가 아니라 OS 휴지통으로 이동

검증: `tests/test-operations.js`, `npm audit --audit-level=high`

## 5. 장애 복구·지속 운영 게이트

- 파일 감시 실패 시 색인 오류 상태를 UI로 전달
- 캐시가 없거나 손상되면 전체 재색인으로 복구
- 앱 종료 시 원격 서버·파일 감시·전역 단축키를 정리
- 수동 재색인과 검색 폴더 범위 설정 제공
- 처리하지 못한 예외와 렌더러 종료 원인을 사용자 로그에 기록

검증: `npm run check`, Electron startup smoke test, CI 운영 테스트

## 6. 기관 업무 UX 게이트

- 문서·통계·한글/PDF·최근 수정·큰 파일 바로가기
- 저장 검색·최근 검색·폴더 범위 검색
- 키보드 중심 탐색, Quick Look, 경로 복사, 일괄 이름 변경, 휴지통 이동
- CSV/JSON/EFU 결과 내보내기
- 사용 안내 페이지에서 설치 파일과 Voidtools 공식 참고 주소 제공

검증: renderer contract 85개 ID / 31개 API, 앱 내 사용 안내 로드 확인

## 7. 릴리스·감사 게이트

- `npm run check` 통과
- `npm audit --audit-level=high` 취약점 0개
- `git diff --check` 통과
- GitHub Actions에서 Ubuntu·macOS·Windows 검증 및 macOS·Windows 패키징 성공
- 릴리스 태그가 `main` 커밋과 일치하고 공개 다운로드 자산이 존재
- macOS 릴리스는 Universal DMG 내부 앱과 arm64·x86_64 아키텍처를 검증한 뒤 업로드
- Apple 인증서·공증 시크릿 6개가 모두 있으면 Developer ID 서명과 공증을 검증하고, 모두 없으면 무료 미서명 배포로 진행
- Apple 시크릿이 일부만 등록된 상태는 실패 처리
- 미서명 앱은 다운로드 안내의 Finder Control-클릭 → 열기 절차로 처음 실행하도록 안내하며, 격리 속성을 제거하는 터미널 명령은 권하지 않음

검증 명령:

```bash
npm ci
npm run check
npm audit --audit-level=high
npm run build:mac
npm run build:win
```

현재 릴리스: [v1.3.22](https://github.com/dawith-ai/dawith-search/releases/tag/v1.3.22)

### macOS 배포 방식

비용 없이 배포할 때는 Apple Actions secrets를 등록하지 않고 `macOS release` 워크플로를 실행한다. 워크플로는 Universal DMG와 실행 파일 아키텍처를 확인한 뒤 GitHub Release에 올린다. 아래 여섯 secrets를 모두 등록하면 Developer ID 서명과 공증 경로를 사용한다.

- `APPLE_CERTIFICATE`: Developer ID Application `.p12`의 base64 값
- `APPLE_CERTIFICATE_PASSWORD`: `.p12` 내보내기 암호
- `APPLE_ID`: Apple Developer 계정 이메일
- `APPLE_PASSWORD`: 공증용 앱 전용 암호
- `APPLE_TEAM_ID`: Apple Developer Team ID
- `KEYCHAIN_PASSWORD`: CI 임시 키체인 암호

시크릿이 일부만 등록되면 설정 오류로 실패한다. 사용자는 공식 안내 페이지의 순서대로 DMG를 열고 앱을 응용 프로그램 폴더에 넣은 다음, Finder에서 앱을 Control 키를 누른 채 클릭해 `열기`를 선택한다. `xattr`로 격리 속성을 제거하는 절차는 배포 안내에 사용하지 않는다.

## 운영 경계

이 앱은 기관 내부 파일 검색·정리 도구다. 중앙 사용자 계정, 원격 다중 사용자 권한 관리, 서버 백업, 문서 암호화 저장소는 범위 밖이다. 해당 요구가 생기면 원격 서버 기능을 조직 인증 체계 뒤에 두고 별도 서버 제품으로 분리해야 한다.

# ⚡ Dawith Search (다윗 서치)

> **Voidtools Everything(초고속 Windows 파일 검색기)의 모든 기능 클론 & AI 차세대 기능 대폭 강화 버전**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6.svg)](https://github.com/dawith-ai/dawith-search)
[![Speed](https://img.shields.io/badge/Search%20Speed-%3C15ms-brightgreen.svg)]()

---

## 🚀 왜 Dawith Search 인가?

[Voidtools Everything](https://www.voidtools.com/ko-kr/)은 세계에서 가장 빠르고 가벼운 Windows 데스크톱 파일 검색 유틸리티입니다.  
**Dawith Search**는 Everything의 강력한 검색 문법, 초고속 인덱싱, 실시간 파일 감시 메커니즘을 100% 클론함과 동시에, 현대 사용자를 위한 **혁신적인 디벨롭 기능**들을 탑재한 차세대 데스크톱 검색 엔진입니다.

---

## 📊 기존 Everything 대비 기능 대조표

| 분류 | 기능 항목 | 기존 Voidtools Everything | ⚡ Dawith Search |
|---|---|---|---|
| **검색 엔진** | 타이핑 즉시 실시간 검색 | ✅ 지원 | ✅ 지원 (< 15ms) |
| | 불리언 연산 (`AND`, `OR(\|)`, `NOT(!,-)`) | ✅ 지원 | ✅ 완벽 호환 |
| | 와일드카드 (`*`, `?`) & 정규식 (`regex:`) | ✅ 지원 | ✅ 완벽 호환 |
| | 크기/날짜 필터 (`size:`, `dm:`, `dc:`) | ✅ 지원 | ✅ 완벽 호환 (`size:>100mb`, `dm:today` 등) |
| | 카테고리 매크로 (`doc:`, `pic:`, `video:` 등) | ✅ 지원 | ✅ 완벽 호환 + 한글 탭 지원 |
| | 본문 내용 검색 (`content:keyword`) | ✅ 지원 | ✅ 텍스트/코드/문서 지원 |
| | 결과 내보내기 | CSV, TXT, EFU, JSON | ✅ CSV, TXT, JSON, **EFU 완벽 호환** |
| | CLI 터미널 검색기 | `es.exe` | ✅ `dawith-cli` 완벽 제공 |
| **디벨롭 기능** | **UI/UX 디자인** | 고전 Win32 (XP/7 스타일) | ✨ **Windows 11 Fluent Dark/Light 모던 UI** |
| | **스페이스바 Quick Look** | ❌ 복잡한 IFilter 별도 설치 필요 | ✨ **스페이스바로 이미지, 코드, 영상, 오디오 즉시 팝업 미리보기** |
| | **AI 자연어 검색** | ❌ 불가 | ✨ **한국어/영어 자연어 문장 자동 Everything 문법 변환** |
| | **스토리지 & 중복 정리** | ❌ 기본 dupe만 지원 | ✨ **디스크 용량 시각화 & MD5 해시 중복 파일 분석기** |
| | **가상 태그 & 즐겨찾기** | ❌ 불가 | ✨ **파일시스템 변형 없는 `#태그` 및 별표 즐겨찾기** |
| | **모바일 원격 검색** | 구형 HTTP Web UI | ✨ **스마트폰 QR 1초 스캔 & 반응형 PWA 모바일 다운로드/스트리밍** |
| | **글로벌 핫키** | 별도 설정 필요 | ✨ `Alt + Space` 어디서든 0.1초 소환 |

---

## 🛠️ 주요 기능 상세

### 1. Everything 검색 문법 100% 완벽 지원
- **연산자**: `보고서 2026` (AND), `jpg|png` (OR), `doc !temp` (NOT)
- **와일드카드 & 정규식**: `*.xlsx`, `test?.txt`, `regex:^[0-9]{4}_`
- **크기 조건**: `size:>100mb`, `size:<10kb`, `size:empty`, `size:huge`
- **수정일/생성일**: `dm:today`, `dm:yesterday`, `dm:lastweek`, `dm:thisyear`
- **카테고리 퀵 탭**:
  - 📄 문서 (`doc:`) : `pdf`, `docx`, `xlsx`, `pptx`, `hwp`, `hwpx`, `txt`, `md`
  - 🖼️ 사진 (`pic:`) : `png`, `jpg`, `gif`, `webp`, `svg`, `psd`
  - 🎬 동영상 (`video:`) : `mp4`, `mkv`, `avi`, `mov`, `wmv`
  - 🎵 음악 (`audio:`) : `mp3`, `wav`, `flac`, `aac`
  - 📦 압축 (`zip:`) : `zip`, `7z`, `rar`, `tar`, `gz`
  - ⚙️ 실행 (`exe:`) : `exe`, `bat`, `cmd`, `ps1`, `msi`

### 2. 👁️ 스페이스바 Quick Look (인스턴트 미리보기)
검색 결과 목록에서 <kbd>Space</kbd> 키를 누르면:
- **이미지**: 고해상도 확대 줌 뷰어
- **코드 & 텍스트**: 줄 번호와 구문 강조가 적용된 소스코드 뷰어
- **오디오 / 비디오**: 인앱 HTML5 미디어 플레이어로 즉시 청취/시청
- **PDF & 문서**: 팝업 뷰어

### 3. ✨ AI 자연어 스마트 검색 (AI Smart Query)
Everything 문법을 외울 필요 없이 말하듯이 입력하면 자동 변환됩니다.
- *"지난주 다운로드한 100MB 이상 동영상"* ➔ `dm:lastweek size:>100mb video:`
- *"어제 작성한 엑셀 파일"* ➔ `dm:yesterday ext:xlsx,xls`
- *"사진 중 바다"* ➔ `pic: 바다`

### 4. 📱 스마트폰 모바일 원격 검색 & 다운로드
- 상단의 `📱 모바일 공유` 버튼 클릭
- 같은 Wi-Fi에 있는 스마트폰 카메라로 QR 코드를 스캔
- 스마트폰 브라우저에서 내 PC 전체 파일을 실시간 검색하고 즉시 스마트폰으로 다운로드 및 미디어 스트리밍!

### 5. 📊 스토리지 용량 & 중복 파일 청소기
- 카테고리별 디스크 사용량 시각화 바 차트
- MD5/SHA256 해시를 기반으로 바이트 단위까지 일치하는 중복 파일 검출
- 절약 가능한 하드 디스크 공간 계산 및 원클릭 파일 위치 확인
- 디스크 내 대용량 파일 TOP 50 랭킹

---

## ⌨️ 단축키 안내

| 단축키 | 기능 |
|---|---|
| <kbd>Alt + Space</kbd> | 어디서든 Dawith Search 즉시 열기 / 최소화 |
| <kbd>Space</kbd> | 선택 항목 즉시 Quick Look 미리보기 |
| <kbd>Enter</kbd> | 기본 연결 프로그램으로 실행 |
| <kbd>Ctrl + Enter</kbd> | 파일이 위치한 상위 폴더 탐색기 열기 |
| <kbd>Ctrl + C</kbd> | 파일 전체 절대 경로 클립보드 복사 |
| <kbd>F2</kbd> | 파일 / 폴더 이름 변경 |
| <kbd>Delete</kbd> | 휴지통으로 안전 삭제 |
| <kbd>Ctrl + K</kbd> | 명령 팔레트 실행 |

---

## 💻 CLI (명령줄 검색) - Everything `es.exe` 호환

```bash
# 기본 검색
dawith-cli report.docx

# 문법 조합 검색
dawith-cli "ext:pdf size:>10mb" -l 20

# 정렬 옵션
dawith-cli "*.png|*.jpg" -s size -r
```

---

## 📦 설치 및 실행 방법

### 개발 모드 실행
```bash
git clone https://github.com/dawith-ai/dawith-search.git
cd dawith-search
npm install
npm start
```

### Windows EXE 패키징 (포터블 실행 파일 생성)
```bash
npm run build:win
# dist/DawithSearch-1.0.0-portable.exe 가 생성됩니다.
```

---

## 📜 라이선스
MIT License © 2026 Dawith AI. All rights reserved.

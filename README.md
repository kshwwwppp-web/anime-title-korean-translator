# 🎌 Anime Title Korean Translator

> 사용자가 허용한 웹사이트의 애니메이션/미디어 제목을 자동으로 감지하여 한국어 제목을 표시하고, 수동 치환 규칙을 우선 적용할 수 있는 Chrome 확장 프로그램(Manifest V3)입니다.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Privacy%20Policy-GitHub%20Pages-informational)](https://kshwwwppp-web.github.io/anime-title-korean-translator/extension/privacy-policy.html)

---

## ✨ 주요 기능

1. **자동 제목 감지 및 한국어 변환**
   - 로마자(Romaji), 영어, 원어(일본어 등) 애니메이션/미디어 제목을 감지하여 자연스러운 한국어 표제어로 변환/표시합니다.
   - AniList GraphQL API, Wikipedia API, Google Translate 폴백 연동을 통해 높은 매칭률을 제공합니다.
2. **수동 치환 규칙 우선 적용**
   - 특정 제목이나 단어를 원하는 한국어 명칭으로 직접 매핑할 수 있으며, 자동 번역보다 최우선으로 적용됩니다.
3. **스마트 로컬 캐싱**
   - 한 번 번역/매칭된 제목은 브라우저 로컬 저장소(`chrome.storage.local`)에 안전하게 캐시되어 불필요한 네트워크 트래픽을 최소화합니다.
4. **사용자 제어 중심의 보안 및 권한 모델**
   - 초기 설치 시 전체 기능이 **OFF** 상태로 유지되며, 기본 적용 사이트가 등록되어 있지 않습니다.
   - 사용자가 직접 옵션 화면에서 도메인을 추가하고 허용한 사이트에 대해서만 런타임 권한(Optional host permissions)을 요청합니다.
   - 외부 스크립트 원격 다운로드가 일절 없으며, 불필요한 계정 정보나 브라우징 기록을 수집하지 않습니다.
5. **실시간 설정 동기화**
   - 설정을 켜고 끄거나 치환 단어를 수정하면 열려 있는 탭에 즉시 반영됩니다.

---

## 📁 디렉토리 구조

```text
anime-title-korean-translator/
├── extension/                       # Chrome 확장 프로그램 소스 코드
│   ├── manifest.json                # 확장 프로그램 매니페스트 (V3)
│   ├── background.js                # 서비스 워커 (API 통신, 번역, 캐시 관리)
│   ├── content.js                   # 웹페이지 내 제목 탐지 및 한국어 배지 주입
│   ├── options.html / options.js    # 설정 팝업 UI 및 스크립트
│   ├── privacy-policy.html          # 개인정보 처리방침 (GitHub Pages 호스팅)
│   └── icons/                       # 크기별 확장 프로그램 아이콘 (16, 32, 48, 128px)
├── store-docs/                      # Chrome Web Store 배포 관련 문서
│   ├── STORE_LISTING_KO.md          # 스토어 등록 정보 (이름, 단일 목적, 설명, 권한 사유)
│   ├── PUBLISH_CHECKLIST.md         # 배포 전/후 체크리스트
│   ├── PRIVACY_HOSTING.md           # 개인정보 처리방침 호스팅 가이드
│   ├── REVIEW_NOTES.txt             # 심사용 메모
│   └── OFFICIAL_REFERENCES.txt      # 구글 정책 가이드 참고 링크
├── .gitignore
└── README.md
```

---

## 📦 다운로드 및 간편 설치 방법 (무료 배포)

Chrome Web Store를 거치지 않고 누구나 무료로 다운로드하여 1분 안에 설치할 수 있습니다:

[![Download Latest Release](https://img.shields.io/badge/Download-Latest%20v6.0.0%20ZIP-orange?style=for-the-badge&logo=github)](https://github.com/kshwwwppp-web/anime-title-korean-translator/releases/latest)

1. [최신 릴리즈(v6.0.0)](https://github.com/kshwwwppp-web/anime-title-korean-translator/releases/download/v6.0.0/anime-title-korean-translator-v6.0.0.zip)에서 **`anime-title-korean-translator-v6.0.0.zip`** 파일을 다운로드합니다.
2. 다운로드한 ZIP 파일의 압축을 원하는 폴더에 풉니다.
3. Chrome 주소창에 `chrome://extensions` 를 입력하여 확장 프로그램 관리 페이지로 이동합니다.
4. 우측 상단의 **‘개발자 모드(Developer mode)’** 토글 스위치를 켭니다.
5. 좌측 상단의 **‘압축해제된 확장 프로그램을 로드합니다(Load unpacked)’** 버튼을 클릭합니다.
6. **2번에서 압축을 푼 폴더를 선택**하면 즉시 설치가 완료됩니다!
7. 툴바 상단의 퍼즐 아이콘(확장 프로그램)에서 고정(Pin)한 뒤 클릭하여 기능을 켜고 적용할 사이트를 등록하세요.

---

## 🛠️ 개발자용 로컬 소스코드 설치 방법

1. 저장소를 클론합니다:
   ```bash
   git clone https://github.com/kshwwwppp-web/anime-title-korean-translator.git
   ```
2. Chrome 브라우저에서 `chrome://extensions`로 이동합니다.
3. 우측 상단의 **개발자 모드(Developer mode)**를 활성화합니다.
4. 좌측 상단의 **압축해제된 확장 프로그램을 로드합니다**를 클릭합니다.
5. 이 저장소 내의 `extension` 폴더를 선택합니다.

---

## 🔒 개인정보 보호 및 권한 정책

- [개인정보 처리방침 전문 보기 (Privacy Policy)](https://kshwwwppp-web.github.io/anime-title-korean-translator/extension/privacy-policy.html)
- 본 확장 프로그램은 제3자 광고 트래커나 사용자 데이터 수집 서버를 일체 운영하지 않습니다.
- 모든 설정 및 캐시는 사용자의 브라우저 내부에만 안전하게 저장됩니다.

---

## 📄 라이선스 (License)

This project is licensed under the [MIT License](LICENSE).

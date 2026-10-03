# 공개 배포 체크리스트

## 코드/패키지
- [x] Manifest V3
- [x] manifest.json에 name/version/description/icons 포함
- [x] 필수 사이트 권한에서 특정 콘텐츠 사이트 제거
- [x] 사용자 사이트 접근은 optional HTTPS host permission으로 런타임 요청
- [x] 신규 설치 기본 OFF / 적용 사이트 없음
- [x] 개인정보 안내 및 캐시 삭제 UI
- [x] 외부 JavaScript 다운로드/실행 없음
- [x] JS 문법/manifest JSON 검사

## 게시자가 직접 해야 하는 항목
- [ ] Chrome Web Store 개발자 등록 및 2단계 인증
- [ ] privacy-policy.html의 문의 이메일/지원 URL을 실제 값으로 수정
- [ ] privacy-policy.html을 공개 HTTPS URL(GitHub Pages 등)에 게시
- [ ] Developer Dashboard > Privacy에 위 URL 입력
- [ ] Single purpose, 권한 사유, 데이터 사용 공개를 STORE_LISTING_KO.md와 일치하게 입력
- [ ] 실제 기능 스크린샷 업로드 (누락 시 심사 거절 가능)
- [ ] 아이콘/설명/스크린샷이 실제 기능과 일치하는지 확인
- [ ] 지원 URL 또는 지원 연락 경로 준비
- [ ] 비공개/Unlisted 테스트 후 Public 전환 권장

## 업로드 파일
`anime-title-korean-translator-v6.0-webstore.zip`을 Developer Dashboard에 업로드합니다.
manifest.json은 ZIP 루트에 있습니다.

# 추가 기능 묶음 (addons) — ✅ 적용 완료 (2026-07-24)

> 2026-07-23 제작, **2026-07-24 index.html에 적용·배포됨.** 아래 "적용 방법"은 이력 참고용.
> 이후 애드온 수정 시에도 캐시 버전(?v=) 올리는 규칙은 동일하다.

## 무엇이 준비됐나

| 기능 | 파일 | 유료 여부 |
|---|---|---|
| 회원 체계 (무료 체험 한 달 → 유료 전환 안내) | `membership.js` | — |
| **기록 탭**: 건별 운송료 입력 → 오늘·이번 주·이번 달·기간 지정 자동 합산, 운행 요약 저장 | `records.js` | 유료 |
| 운행 건 ↔ **적재함 화물 연결** (체크박스 선택, 연결 안 함도 가능) | `records.js` | 유료 |
| **주유소 탭**: 차량 종류(전기/LPG/디젤)별 경로 주변 추천 3곳 + 내비 연결 | `stations.js` | 무료 |
| 유료 지도(TMAP)로 **정확한 도착 예정 시간**·실제 통행료 | `paidmap.js` | 유료 + API 키 필요 |
| 위 기능들 스타일 (라이트/다크 자동) | `features.css` | — |
| 적용 전 미리보기 페이지 | `미리보기.html` | — |

### 사용자 흐름 요약
- 배송지를 추가하면(문자 인식/직접 입력) **운송료 입력 칸이 자동 생성**된다 (경로 탭·운행 탭 양쪽).
- 각 운행 건에서 `📦 적재함 화물 연결`을 누르면 적재 탭 화물 목록이 체크박스로 나온다.
  적재함에 입력 안 한 짐은 연결 없이 두면 된다.
- **운행 종료**를 누르면 운행 요약 + 건별 운송료가 기록 탭에 저장된다.
  운행 종료를 안 눌러도, 날짜가 지나면 그날 건들은 자동으로 기록에 보관된다.
- 무료 회원이 기록(또는 운송료 칸)을 누르면 **"유료 회원이 되면 열립니다"** 안내 모달이 뜬다.
  첫 사용일부터 **31일 무료 체험** 동안은 모두 열려 있고, 체험 중에도 `유료 전환` 버튼으로 미리 전환을 유도한다.
  체험이 끝나도 **기록 데이터는 지워지지 않고** 유료 전환 시 그대로 다시 보인다.

## 적용 방법 (index.html 5줄)

1. `<head>` 안, 기존 `styles.css` 링크 **아래**에:
   ```html
   <link rel="stylesheet" href="addons/features.css?v=20260723a">
   ```
2. `</body>` 직전, 기존 `app.js` 스크립트 **아래**에 (순서 중요 — membership이 먼저, paidmap이 마지막):
   ```html
   <script src="addons/membership.js?v=20260723a"></script>
   <script src="addons/stations.js?v=20260723a"></script>
   <script src="addons/records.js?v=20260723a"></script>
   <script src="addons/paidmap.js?v=20260723a"></script>
   ```
3. 수정할 때마다 `?v=` 캐시 버전을 올린다 (기존 규칙과 동일).
4. 탭 버튼(주유소·기록)과 화면(panel)은 스크립트가 **스스로 만들어 붙이므로** HTML 추가 작업이 없다.
5. 적용 후 `미리보기.html`은 지워도 된다.

### 적용 전 미리보기
```
./실행하기.command   (또는 python3 -m http.server 8787)
→ http://localhost:8787/addons/미리보기.html      # 일반
→ http://localhost:8787/addons/미리보기.html?demo # 예시 경로 포함
```

## app.js를 안 고치고 어떻게 붙였나 (수정 시 주의)

| 연결 고리 | 방식 | app.js에서 이걸 바꾸면 같이 점검 |
|---|---|---|
| 운행 종료 → 기록 저장 | `#btn-end-trip` 클릭을 **캡처 단계**에서 먼저 받아 운행 상태를 복사, 다음 틱에 `state.trip === null`이면(사용자가 확인을 누른 경우) 저장 | `#btn-end-trip` id, `state.trip` 구조 |
| 배송지 추가 → 운송료 칸 자동 생성 | `#stop-list` MutationObserver + `state.stops` 개수 비교 | `#stop-list` id |
| 새 탭 (주유소·기록) | `#tabs`에 버튼, `main.container`에 `panel-fuel`/`panel-log` 추가 후 전역 `switchTab()` 호출 | `switchTab`이 `panel-{이름}` 규칙을 유지하는지 |
| 유료 지도 도착시간 | `Router.optimize`와 `buildSchedule`을 **감싸서(wrap)** TMAP 값으로 교체 | 두 함수의 시그니처 |
| 전역 재사용 | `state, cargoItems, itemLabel, toast, esc, uid, isoDate, fmtDateK, fmtKm, fmtDur, Geo, Router.haversine, orderedStops, driveStartCoord, hasCoord, isFutureStop` | 이 이름들을 바꾸면 addons도 수정 |

## 회원 체계 (임시 구현 — 결제 연동 전)

- 상태는 이 휴대폰 `localStorage`(`cargo-member-v1`)에만 저장된다.
- 무료 체험: membership.js가 **처음 로드된 날**부터 31일 (즉, 기능을 배포한 날부터 시작).
- 유료 전환: 안내 모달의 **가입 코드** 입력 → 31일 이용권(연장 가능).
  코드는 `membership.js` 맨 위 `ACTIVATION_CODES`에 있다 (현재: `화물사랑`, `CARGO2026` — 배포 전 변경 권장).
- 가격 문구는 `PRICE_LABEL` 상수 (현재 "월 4,900원 (금액 확정 전)").
- **실제 결제(PG/인앱) 도입 시** 바꿀 곳은 `membership.js`의 `activate()`와 `isPaid()` 두 함수뿐이다.
  클라이언트 저장 방식이라 마음먹으면 우회 가능 — 정식 유료화 때는 서버 인증 필수.

## 유료 지도(TMAP) 켜는 법

1. https://openapi.sk.com 에서 TMAP appKey 발급 (자동차 경로안내 API, 무료 쿼터 있음)
2. `paidmap.js`의 `APP_KEY` 상수에 넣거나, 브라우저 콘솔에서 `PaidMap.setKey('키')`
3. 유료 회원(또는 체험 중) + 키가 있으면: 경로 계산 후 구간별 시간·거리·통행료가
   실시간 교통 반영 값으로 바뀌고, 자체 교통 배율(trafficFactor)은 이중 적용되지 않는다.
   실패하면 조용히 기존 무료(OSRM) 값으로 동작한다.

## 데이터 저장 키 (localStorage)

- `cargo-member-v1` — 회원 상태 (첫 사용일·플랜·만료일)
- `cargo-jobs-active-v1` — 오늘 진행 중 운행 건(운송료 미보관분)
- `cargo-log-v1` — 보관된 건별 기록 (최대 600건)
- `cargo-trips-v1` — 운행(시작~종료) 요약 (최대 120회)
- `cargo-fuel-type-v1` — 주유소 탭 차량 종류
- `cargo-tmap-key` — TMAP appKey (setKey 사용 시)

## 검증한 것 (2026-07-23, 헤드리스 크롬 스모크 테스트)

- 콘솔/페이지 오류 0건. 탭 5개(경로·운행·적재·주유소·기록) 정상 주입.
- 체험 D-31 상태에서 운송료 카드 열림 → 건 추가·70,000원 입력 → 기록 탭 오늘/이번 주 합산 표시 확인.
- 체험 만료 시뮬레이션 → 기록 탭 잠금 화면 + "유료 회원이 되면 열립니다" 모달 + 경로 탭 카드 잠금 확인.
- 유료 전환 후 기존 기록(70,000원 건) 보존된 채 다시 열림 확인.
- 주유소 탭: ?demo 경로(마곡→강남→판교→수원) 기준 전기차 충전소 3곳 추천 + 내비 버튼 렌더 확인.
  (Overpass 공개 서버라 연속 호출 시 일시 제한이 있을 수 있음 — 예비 서버 2곳 + 20초 타임아웃 + 동일 조건 캐시로 대응)

## 남은 결정·추후 과제

- [ ] 유료 가격 확정 (`PRICE_LABEL`) 및 가입 코드 교체
- [ ] 실제 결제 수단(PG·인앱) + 서버 인증 → `activate()`/`isPaid()` 교체
- [ ] 기록 서버 백업·기기 간 동기화 (지금은 휴대폰에만 저장)
- [ ] 주유소 실시간 유가(오피넷 API — 키 필요)·EV 충전기 실시간 상태(환경부 API — 키 필요)
- [ ] TMAP appKey 발급 후 유료 지도 활성화

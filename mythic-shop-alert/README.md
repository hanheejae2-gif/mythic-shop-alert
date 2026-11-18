# 신화 상점 알리미 (LoL Mythic Shop Alert)

리그 오브 레전드 신화 정수 상점의 공개 로테이션을 수집하고, 사용자가 즐겨찾기한 상품이 새 로테이션에 등장하면 휴대폰으로 웹 푸시 알림을 보내는 모바일 우선 PWA입니다.

## 포함 기능

- **즐겨찾기 목록**: 현재까지 수집된 신화 정수 상점 상품을 스크롤·검색·종류별 필터링하고 별표로 등록
- **오늘의 상점**: 현재 판매 중인 신화 정수 상점의 주요 상품 / 2주 / 주간 / 일일 섹션 표시
- **즐겨찾기 동기화**: 브라우저 로컬 저장 + 서버의 기기별 설정 저장
- **푸시 알림**: 즐겨찾기한 안정적 상품 식별자(`itemKey`)가 새 로테이션에 들어오면 알림
- **로테이션 감지**: itemshop.gg `/rotations`를 1분마다 확인하고, 변경 fingerprint가 바뀐 경우에만 전체 상점 재조회
- **일일 스냅샷**: 매일 00:05, `Asia/Seoul` 시간대로 오늘의 상점 데이터를 저장
- **오프라인 초기 화면**: 프로젝트에 포함된 2026-11-18 데이터 스냅샷을 네트워크 실패 시 초기 대체 데이터로 사용
- **역대 카탈로그 자동 확장**: API 키가 설정되면 기록된 과거 신화 상점 목록을 자동으로 가져와 `itemKey` 기준으로 합치고 상품별 판매 이력을 저장
- **판매 예정 상품 포함**: 현재 API 응답에 `upcoming: true`로 제공된 상품은 즐겨찾기 카탈로그에 미리 등록

## 즐겨찾기 카탈로그와 역대 이력 범위

즐겨찾기 목록(`/api/catalog`)은 다음 데이터를 하나의 상품 목록으로 합칩니다.

1. 현재 판매 중인 신화 정수 상점 상품: 키 없이 `/api/v1/shop/league-of-legends`에서 수집
2. API가 현재 상점 응답의 `sections`에 `upcoming: true`로 제공하는 판매 예정 상품: 미리 카탈로그에 추가하되 오늘의 상점에는 표시하지 않음
3. itemshop.gg가 수집한 과거 신화 정수 상점 로테이션: `/api/v1/history/league-of-legends`와 날짜별 `/history/{game}/{date}`를 이용해 `itemKey` 기준으로 중복 제거

과거 이력 API는 무료 API 키가 필요합니다. itemshop.gg 계정에 Discord로 로그인해 [API 키 발급 페이지](https://itemshop.gg/account#api)에서 키를 만든 뒤 서버의 `.env` 파일에 `ITEMSHOP_API_KEY=...`로 입력하세요. 키는 Node 서버에서만 사용하며 브라우저 코드로 보내지 않습니다.

키가 설정되면 서버 시작 시 누락된 과거 기록을 자동으로 가져오고, 이후 매일 00:20(KST)에 새로 추가된 이력 날짜를 확인합니다. 최초 전체 이력 가져오기는 데이터 날짜 수에 따라 시간이 걸릴 수 있습니다. 수동으로 실행하려면 다음 명령을 사용하세요.

```bash
npm run sync:history
```

이력 동기화는 과거 상점 스냅샷에 등장한 신화 정수 상품을 `itemKey` 기준으로 하나로 합치고, 각 상품의 `salesHistory`, `historyCount`, `firstSeenDate`, `lastSeenDate`를 저장합니다. 동일한 판매 기간이 여러 스냅샷에 반복되어도 한 번의 판매 체류로 집계하도록 `availability.from/until`을 기준으로 중복을 제거합니다.

**완전한 전 역대 카탈로그를 보장하지는 않습니다.** API가 제공하는 이력은 itemshop.gg가 기록하기 시작한 시점부터의 기록만 포함합니다. 현재 공개된 LoL 트래커는 2026년 10월 8일부터 기록을 수집했다고 안내하고 있습니다. 그 이전에 판매된 상품은 카탈로그에서 누락될 수 있습니다. 또한 LoL의 `nextRotations`는 API 문서상 사전 상품 목록을 제공하지 않으므로, 판매 예정 상품은 현재 `/shop` 응답에 실제 `upcoming: true` 섹션과 상품이 포함된 경우에만 표시할 수 있습니다.

`itemKey`가 없는 일부 특수 목록은 표시하되 안정적인 식별자가 없어 즐겨찾기 및 입고 알림 추적을 비활성화합니다.

## 실행 방법

필요 사항: Node.js 20 이상

```bash
cd mythic-shop-alert
npm install
cp .env.example .env
npm run vapid
```

`npm run vapid`가 출력한 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`를 `.env`에 입력하고 `VAPID_SUBJECT`의 이메일도 본인 주소로 바꾸세요. 개인 키는 절대로 브라우저 코드나 저장소에 올리지 마세요.

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다. `localhost`는 개발용 보안 컨텍스트로 취급되어 로컬 푸시 테스트가 가능합니다.

## 휴대폰 설치 및 알림

운영 환경에서는 HTTPS 도메인으로 앱을 배포해야 합니다.

- **Android**: Chrome에서 사이트를 열고 브라우저 메뉴의 앱 설치 / 홈 화면에 추가를 선택한 뒤 앱 안에서 `알림 켜기`를 누릅니다.
- **iPhone**: iOS/iPadOS 16.4 이상에서 Safari로 앱을 열고 공유 → 홈 화면에 추가를 선택합니다. 홈 화면에 설치된 앱을 실행한 뒤 `알림 켜기`를 눌러 권한을 허용합니다. iOS의 웹 푸시는 홈 화면 웹 앱에서 동작하며 사용자 제스처로 권한을 요청해야 합니다.

푸시 알림은 브라우저 화면만으로 보내지지 않습니다. 이 프로젝트의 Node 서버가 실행 중이어야 하고 VAPID 키와 HTTPS 배포, 사용자의 알림 권한이 필요합니다.

## 운영 스케줄

- `/api/v1/rotations`: 매 1분 확인 (상점 fingerprint 변경 감지)
- `/api/v1/shop/league-of-legends`: fingerprint가 바뀌었을 때만 호출
- 일일 스냅샷: 매일 00:05 `Asia/Seoul`
- 상품 입고 알림: 직전 관측 상품 키 목록에 없던 `itemKey`가 새 상점에 등장했을 때, 해당 상품을 즐겨찾기한 기기에 전송
- 역대 카탈로그 백필: 서버 시작 시 미수집 기록을 가져오고, 로테이션 변경 시 및 매일 00:20(KST)에 새 이력 날짜를 확인

LoL 상점은 고정된 매일 자정 초기화 상점이 아닙니다. 이 앱은 로테이션이 실제로 바뀌면 즉시 감지하고, 00:05 KST에는 일일 기록도 별도로 남깁니다.

## 역대 카탈로그 동기화

1. itemshop.gg 계정에서 무료 API 키를 발급합니다.
2. `.env`에 `ITEMSHOP_API_KEY=...`를 입력합니다.
3. 최초 백필을 실행합니다.

```bash
npm run sync:history
```

서버가 이미 실행 중이라면 재시작한 뒤 자동 백필되며, 이후 매일 00:20(KST)에 새 이력 날짜를 동기화합니다. 키는 서버에서만 읽고 클라이언트로 전달하지 않습니다. 키 없이도 현재 상점 조회·현재/판매 예정 상품 카탈로그·즐겨찾기·푸시 기능은 사용할 수 있습니다.

## 데이터베이스와 여러 기기

기본 DB는 `data/mythic-shop.sqlite`입니다. 운영 서버에서는 해당 파일을 영구 저장소에 두어야 합니다. 현재 즐겨찾기는 익명 기기 ID 기준이며, 브라우저 저장소를 지우거나 다른 기기를 사용하면 별도의 즐겨찾기 목록이 됩니다. 여러 기기 간 동기화를 원하면 추후 계정 로그인 기능을 추가해야 합니다.

## API

- `GET /api/shop/today` 오늘 저장된 상점
- `GET /api/catalog` 현재/판매 예정/역대 수집 상품 카탈로그와 이력 범위 메타데이터
- `GET /api/preferences/:deviceId` 기기별 즐겨찾기 조회
- `PUT /api/preferences/:deviceId` 기기별 즐겨찾기 저장
- `POST /api/push/subscribe` 푸시 구독 등록
- `POST /api/push/test` 테스트 알림 전송
- `GET /api/health` 서버 상태

## 출처 및 데이터 이용

앱 화면에는 데이터 출처 링크를 표시합니다: [Data from itemshop.gg](https://itemshop.gg/league-of-legends)

- API 문서: https://itemshop.gg/developers
- 이용 약관: https://itemshop.gg/terms#api
- API 요청 제한, ETag, 이력 데이터의 이용 조건은 위 문서를 확인하세요.

이 프로젝트는 팬 제작 도구이며 Riot Games와 공식 제휴·승인을 받은 앱이 아닙니다.

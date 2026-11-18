# 신화 상점 알리미 v1.5

리그 오브 레전드 신화 정수 상점의 상품을 장기 보관하는 **Master Pool**과 현재 상점 로테이션을 비교해, 즐겨찾기 상품이 다시 등장하면 기기별 웹 푸시 알림을 보내는 모바일 우선 PWA입니다.

## v1.5 변경 사항

### 1. 신화 등급 스킨 후보 159종 통합

- itemshop.gg LoL 카탈로그에서 `Rarity = Mythic`, `Item type = SKIN` 필터를 적용해 확인한 카탈로그 항목 173개를 수집했습니다.
- 같은 게임 스킨 ID를 가리키는 중복 상품 페이지 14개를 제거해 **159개의 고유 스킨 ID**로 정리했습니다.
- 목록에는 프레스티지, 마법공학, 재의(Ashen), 크리스탈리스(Crystalis), PAX 등 카탈로그에서 Mythic 희귀도로 분류된 스킨이 포함됩니다.
- v1.4의 `data/master-pool-seed.json`에 이미 있던 마법공학 뽀삐(ID 78015)는 동일한 키로 병합되도록 했습니다. 따라서 v1.4 seed 대비 seed 행이 늘어난 수는 158개입니다.
- 모든 데이터는 안정적인 상품 키 `lol:item:skin:{skinId}`를 사용합니다. 이후 실시간 상점 API에서 같은 `itemKey`가 나타나면 별도 중복 행을 만들지 않고 기존 후보를 갱신합니다.

### 2. 실제 판매 확인 전까지 후보 상태 유지

중요: itemshop.gg의 `Mythic` 필터는 **상품 희귀도 분류**입니다. 해당 스킨이 신화 정수 상점에서 과거에 판매됐거나 앞으로 반드시 판매될 수 있다는 뜻은 아닙니다.

따라서 이번에 수집한 159개는 모두 `candidate`로 등록합니다. 상점 API 또는 판매 이력에서 실제 Mythic Shop 로테이션이 관측되면 기존 로직에 따라 `confirmed`로 승격됩니다. 확인되지 않은 가격, 판매 날짜, 판매 이력은 임의로 채우지 않았습니다.

### 3. 기존 DB와 중복 없는 자동 병합 및 수량 보고

- Render의 기존 Persistent Disk 및 SQLite 데이터베이스를 그대로 사용합니다.
- 서버 시작 시 기존 `catalog_items`의 상품을 `master_pool_items`로 먼저 이전한 다음 v1.5 seed를 병합합니다.
- 기존 상품과 키가 겹치는 경우 신규 상품을 추가하지 않고 기존 행에 병합합니다. `confirmed` 상품이 `candidate`로 낮아지지 않습니다.
- 최초 seed 병합 결과는 `/api/catalog`의 `seedImport`에 기록됩니다. `inserted`는 기존 DB와 중복되지 않아 새로 추가된 수이고, `alreadyPresent`는 이미 DB에 있던 키와 일치해 병합된 수입니다.
- 서버 로그에도 신규 추가/기존 병합/오류 수가 표시됩니다.

### 4. 아직 이번 수집에 포함되지 않은 유형

이번에 완료된 데이터 수집은 Mythic 희귀도 스킨 필터에 한정됩니다. 다음 유형은 이 v1.5 데이터셋에 포함되지 않았습니다.

- 크로마
- 소환사 아이콘
- 와드 스킨
- 감정표현 및 기타 상품

앱의 상품 유형 필터와 Master Pool 구조는 이 유형들을 저장할 수 있지만, 데이터가 수집·검증되기 전까지 빈 상태로 둡니다.

## v1.5 데이터 파일

| 파일 | 내용 |
|---|---|
| `data/master-pool-seed.json` | 서버 DB에 병합할 스킨 후보 159개 |
| `data/master-pool-catalogue.json` | 수집 메타데이터와 159개 항목을 포함한 전체 데이터셋 |
| `data/master-pool-v1.5-audit.json` | 수집 건수, 중복 제거 수, 필터 및 미수집 유형 요약 |
| `scripts/verify-master-pool.js` | JSON 구조, 상품 키, 상태 및 데이터 개수 검증 |

## 데이터 수량과 기존 245개 카탈로그에 대한 설명

이번 작업에서 확인된 수량은 다음과 같습니다.

| 구분 | 수량 |
|---|---:|
| itemshop.gg 카탈로그 상품 페이지 | 173 |
| 중복 제거 | 14 |
| 고유 신화 희귀도 스킨 ID | **159** |
| v1.4 seed에 이미 있던 마법공학 뽀삐 | 1 |
| v1.4 seed 대비 새로 추가된 데이터 행 | **158** |

기존에 사용하던 245개 카탈로그가 저장된 실제 Render SQLite 파일은 이 작업 환경에 없으므로, 그 245개와 159개 사이의 실제 중복 수를 여기서 미리 확정할 수는 없습니다. 이 프로젝트는 배포 시 기존 DB를 직접 대조하고, 실제 신규 추가 수를 `GET /api/catalog` 응답의 `seedImport.inserted`로 표시합니다. 이 수치가 기존 245개를 유지한 상태에서 새로 늘어나는 정확한 개수입니다. 단순 합산한 403개를 최종 수량으로 간주하지 마세요.

## 실행 방법

필요 사항: Node.js 20 이상

```bash
npm install
cp .env.example .env
npm run vapid
```

`npm run vapid`가 출력한 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`를 `.env`에 입력하고 `VAPID_SUBJECT`를 본인 이메일 주소로 설정합니다. 기존 서버에서 이미 쓰는 VAPID 키가 있다면 새로 만들지 말고 기존 키를 그대로 사용하세요.

과거 판매 이력 수집을 사용하려면 itemshop.gg에서 발급받은 키를 서버의 `.env`에 입력합니다.

```env
ITEMSHOP_API_KEY=발급받은_API_키
```

키는 서버에서만 보관해야 하며 브라우저 코드나 Git 저장소에 넣지 않습니다.

```bash
npm run check
npm start
```

`npm run check`는 JavaScript 구문, JSON 파싱 및 v1.5 Master Pool 데이터의 159개 고유 키/후보 상태를 검사합니다.

선택적으로 seed 병합을 다시 실행할 수 있습니다.

```bash
npm run import:master-pool
```

같은 `itemKey`로 재실행해도 중복 행은 추가되지 않습니다.

## Render 기존 서비스 업데이트 방법

기존 Render 서비스를 유지하면서 GitHub 저장소의 프로젝트 파일만 v1.5로 교체합니다.

1. ZIP을 압축 해제합니다.
2. 압축 안의 `mythic-shop-alert` 폴더 내부 파일을 기존 GitHub 저장소의 루트에 덮어씁니다. `package.json`이 저장소 최상위에 있어야 합니다.
3. `.env` 파일이나 API 키/VAPID 비밀키를 GitHub에 업로드하지 않습니다. `.env.example`은 올려도 됩니다.
4. GitHub에 commit/push하면 Render가 재배포합니다.
5. Render의 기존 환경변수와 Persistent Disk는 그대로 유지합니다.

기존 Render 환경변수 `DATABASE_PATH`가 `/var/data/mythic-shop.sqlite`를 가리키고, 해당 경로에 Persistent Disk가 연결되어 있는지 확인하세요. 기존 DB가 영구 디스크에 있다면 서버 시작 시 기존 상품과 판매 이력을 Master Pool로 이전한 뒤 159개 후보를 중복 키 기준으로 병합합니다.

기존 `ITEMSHOP_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`는 다시 만들거나 ZIP에 입력할 필요가 없습니다.

## 배포 후 확인

- 앱 화면: `https://서비스주소.onrender.com/`
- Master Pool 및 병합 상세: `https://서비스주소.onrender.com/api/catalog`
- 서버 상태: `https://서비스주소.onrender.com/api/health`
- 푸시 설정 여부: `https://서비스주소.onrender.com/api/config`

`/api/catalog` 응답에서 다음 값을 확인합니다.

- `count`: Master Pool 전체 상품 수
- `masterPool.confirmed`: 실제 판매 관측으로 확인된 상품 수
- `masterPool.candidate`: 이력 미확인 후보 상품 수
- `seedImport.inserted`: 기존 DB에 없어서 v1.5 seed에서 새로 추가된 상품 수
- `seedImport.alreadyPresent`: 기존 DB에 키가 있어 중복 추가되지 않고 병합된 상품 수
- `history.importedDays`: itemshop.gg 과거 이력에서 가져온 날짜 수
- `history.lastError`: 마지막 과거 이력 수집 오류

## Master Pool 상태 규칙

| 상태 | 의미 |
|---|---|
| `confirmed` | 실제 Mythic Shop API/과거 이력에서 관측한 상품 |
| `candidate` | 카탈로그 분류 등으로 후보에 등록했지만 실제 Mythic Shop 판매는 아직 확인하지 못한 상품 |

기존 DB에서 이전되는 판매 관측 상품은 `confirmed`로 보존됩니다. 같은 항목을 후보 seed가 다시 읽어도 `confirmed` 상태를 낮추지 않습니다.

## API 및 운영 스케줄

- `GET /api/shop/today`: 오늘의 상점 데이터
- `GET /api/catalog`: Master Pool 전체 상품, 후보/확인 수량, seed 병합 결과 및 이력 수집 상태
- `GET /api/preferences/:deviceId`: 기기별 즐겨찾기 및 푸시 구독 상태
- `PUT /api/preferences/:deviceId`: 기기별 즐겨찾기 저장
- `POST /api/push/subscribe`: 이 기기의 푸시 알림 켜기
- `DELETE /api/push/subscribe/:deviceId`: 이 기기의 푸시 알림 끄기
- `POST /api/push/test`: 테스트 알림 전송
- `GET /api/health`: 서버 상태
- `GET /api/config`: 서버 VAPID 설정 여부 및 공개키

- 로테이션 감지: itemshop.gg `/api/v1/rotations`를 1분마다 확인
- 오늘의 상점: fingerprint 변경 시 다시 수집
- 일일 스냅샷: 매일 00:05 KST
- 과거 이력 백필: 서버 시작 시 및 매일 00:20 KST
- 푸시: 즐겨찾기된 상품의 `itemKey`가 새 로테이션에서 나타날 때, 알림이 켜진 기기에만 전송

## 출처 및 데이터 이용

- [itemshop.gg LoL 카탈로그](https://itemshop.gg/league-of-legends/catalogue) — 2026-11-18 기준 Mythic rarity / SKIN 필터
- [itemshop.gg LoL 상점](https://itemshop.gg/league-of-legends) — 현재 상점 및 상품 출처
- [itemshop.gg API 문서](https://itemshop.gg/developers)
- [itemshop.gg 이용 약관](https://itemshop.gg/terms#api)
- [Riot Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon) — 한국어 게임 데이터/스킨 ID 보조 확인

이 프로젝트는 팬 제작 도구이며 Riot Games와 공식 제휴·승인을 받은 앱이 아닙니다.

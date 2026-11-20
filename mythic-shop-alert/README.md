# 신화 상점 알리미 v1.5.3

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

앱의 상품 유형 필터와 Master Pool 구조는 이 유형들을 저장할 수 있지만, **v1.5 seed 파일 자체에는** 새 후보 상품으로 추가하지 않았습니다. 기존 Render SQLite에 이미 저장된 상품이나 이후 실제 상점 API에서 발견되는 상품은 삭제되지 않습니다. v1.5.2의 한국어 검색 기능은 seed 종류와 관계없이 현재 DB의 Master Pool 전체 항목을 읽어 별칭을 생성합니다.

## v1.5.2 한국어 검색 및 수동 새로고침 개선

### 1. Master Pool 전체 상품의 한국어 검색

- 서버가 현재 SQLite `master_pool_items`의 상품 ID 전체를 읽어 한국어 검색 별칭 사전을 생성합니다.
- 스킨, 크로마, 감정표현, 소환사 아이콘, 와드 스킨은 CommunityDragon의 한국어(`ko_KR`) 게임 데이터와 상품 ID를 대조합니다.
- 챔피언 한국어 명칭은 기존 Riot Data Dragon 한국어 챔피언 별칭 데이터를 함께 사용합니다.
- CommunityDragon에 별도 ID가 없는 크로마는 스킨 테마, 챔피언명, 크로마 변형명 사전을 조합해 한국어 검색어를 생성합니다.
- 상품 영문명도 검색 별칭에 남겨 두므로 한국어·영어 검색을 모두 지원합니다. 한국어 별칭은 DB의 Master Pool에 실제 존재하는 항목을 기준으로 구성합니다.
- 검색 별칭은 SQLite에 저장하고 서버 시작 시 및 매일 04:10 KST에 갱신합니다. 새 상품이 상점 API를 통해 Master Pool에 추가되면 `/api/search-aliases`가 항목 수 변경을 감지해 별칭을 다시 만듭니다.
- 상품 카드에는 출처에서 확인된 한국어 명칭을 우선 표시합니다. 자동 생성된 크로마 별칭은 검색에 사용하되, 불완전한 번역이 카드 제목에 표시되지 않도록 영문 상품명을 유지합니다.

### 2. 새로고침 버튼을 누르면 외부 상점 API를 직접 호출

- 새로고침 버튼은 `GET /api/shop/today?force=1`을 호출합니다.
- 서버는 일반적인 5분 캐시 신선도 조건을 우회하고 itemshop.gg의 오늘의 상점 API를 직접 다시 요청합니다.
- 동시에 여러 요청이 들어오면 하나의 진행 중인 동기화 Promise를 공유해 외부 API 중복 호출을 막습니다. 이전 60초 수동 새로고침 제한은 제거했습니다.
- 새 데이터를 받으면 SQLite 상점 스냅샷과 Master Pool을 갱신하고, 새로운 로테이션에 즐겨찾기 상품이 등장한 경우 기존 푸시 로직을 실행합니다.
- 외부 API가 stale 데이터 또는 오류를 반환하면 마지막 정상 스냅샷을 보존하고 화면에 실패 메시지를 표시합니다. 갱신 실패를 성공 토스트로 오인하지 않도록 수정했습니다.
- 수동 새로고침이 끝난 뒤 Master Pool과 한국어 검색 사전도 다시 확인하므로, 새로 발견된 상품도 검색 대상에 포함됩니다.

### 3. 추가 API 및 상태 항목

- `GET /api/search-aliases`: 상품 키별 한국어 이름, 검색 별칭, 설명 및 현지화 커버리지 반환
- `/api/health`의 `localizedSearchAliasesUpdatedAt`, `localizedSearchAliasCount`, `localizedSearchAliasItemCount`, `localizedSearchAliasUnmatchedCount`, `localizedSearchAliasesError`: 한국어 검색 사전 생성 상태 확인
- `GET /api/shop/today?force=1`: 외부 상점 API 강제 재조회

## v1.5.3 신화급 소환사 아이콘 자동 수집 및 갱신 시각 개선

### 1. Mythic 소환사 아이콘 자동 수집

- 서버 시작 시와 매일 04:00 KST에 CommunityDragon의 한국어 `summoner-icons.json`을 확인합니다.
- `rarities` 배열에서 `region: "riot"` 및 `rarity: 4`인 아이콘을 Mythic 희귀도 후보로 분류합니다. DJ 소나 얼티밋 리믹스 아이콘 ID `7350`, `7352`가 이 분류에 포함되는 것을 확인했습니다.
- 아이콘은 `lol:item:icon:{iconId}` 키로 Master Pool에 병합합니다. 동일 ID는 중복 추가하지 않습니다.
- 신규 아이콘은 실제 상점 판매가 확인되기 전까지 `candidate` 상태로 등록합니다. 실제 상점 API 또는 과거 판매 이력에서 관측되면 기존 로직으로 `confirmed` 처리됩니다.
- 아이콘 이미지와 한국어 이름은 CommunityDragon 원본 데이터를 사용합니다. 아이콘 수집 후 한국어 검색 별칭을 다시 생성합니다.
- 이 방식은 개별 아이콘 이름을 코드에 하드코딩하지 않으며, CommunityDragon에 신규 Mythic 아이콘이 추가되면 다음 수집 주기에 반영합니다.
- 기존 DB의 확인 상품 상태, 가격, 이미지, 판매 이력은 후보 데이터 재수집으로 초기화되지 않도록 병합합니다.

참고: CommunityDragon의 Mythic 희귀도 후보는 실제 Mythic Shop 판매 이력을 뜻하지 않습니다. 실제 판매 관측 전까지는 후보로 표시합니다. CommunityDragon의 현재 데이터에서 Riot rarity `4`에 해당하는 아이콘은 수집 시점 기준 219개였으며, 이 수량은 원본 데이터 변경에 따라 달라질 수 있습니다.

### 2. 오늘의 상점 아이콘 정규화

- 상점 정규화 로직을 `lib/shop-normalize.js`로 분리해 테스트할 수 있도록 구성했습니다.
- 기존 `Mythic Shop:` 섹션 필터를 유지하면서 해당 섹션 안의 스킨과 소환사 아이콘을 동일한 방식으로 정규화합니다.
- 아이콘의 `id`, `itemKey`, 이름, 유형, 가격, 이미지, 판매 가능 기간을 보존합니다.
- 예정 섹션의 아이콘은 `catalogItems`에 포함하고, 현재 판매 섹션의 아이콘은 `items`에 포함합니다.
- upstream API 원본에 존재하지 않는 아이콘은 합성하지 않습니다. 원본 API에 포함된 상품만 정규화합니다.

### 3. API 수집 시각 표시

- 서버가 상점 API 응답을 성공적으로 받아 DB에 저장한 시각을 `lastFetchedAt`으로 별도 보관합니다.
- `/api/shop/today` 응답에 최상위 `lastFetchedAt`과 `shop.lastFetchedAt`을 제공합니다.
- 원본 공급자의 `shop.updatedAt`과 `meta.generatedAt`은 기존 의미를 유지합니다.
- 화면의 `API 확인` 시각은 `lastFetchedAt`을 사용합니다. 기존 스냅샷은 DB의 `fetched_at`으로 호환 처리합니다.

### 4. 상태 확인

- `/api/catalog`의 `masterPool.icons`는 Master Pool에 등록된 소환사 아이콘 수입니다.
- `/api/health`에는 `mythicIconPoolSyncAt`, `mythicIconPoolCandidateCount`, `mythicIconPoolSyncError`가 추가됩니다.
- `npm run check`는 아이콘 희귀도 판별, 안정적 키, 기존 판매 이력 보존, 혼합 스킨/아이콘 상점 정규화 및 갱신 시각 구조를 검사합니다.

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

`npm run check`는 JavaScript 구문, JSON 파싱, v1.5 Master Pool 데이터의 159개 고유 키/후보 상태 및 한국어 검색 별칭 생성 로직을 검사합니다.

선택적으로 seed 병합을 다시 실행할 수 있습니다.

```bash
npm run import:master-pool
```

같은 `itemKey`로 재실행해도 중복 행은 추가되지 않습니다.

## Render 기존 서비스 업데이트 방법

기존 Render 서비스를 유지하면서 GitHub 저장소의 프로젝트 파일만 v1.5.3으로 교체합니다.

1. ZIP을 압축 해제합니다.
2. 압축 안의 `mythic-shop-alert` 폴더를 엽니다. 이 안에 `package.json`이 있습니다. 첫 화면은 상점과 상품 목록을 먼저 표시하고, 큰 한국어 별칭 사전은 백그라운드에서 불러옵니다.
3. 기존 GitHub 저장소에서 **현재 Render의 Root Directory가 가리키는 폴더**를 엽니다. Root Directory가 비어 있으면 저장소 루트, `mythic-shop-alert`라면 그 하위 폴더입니다.
4. 새 ZIP 안의 `mythic-shop-alert` 폴더 내부 파일을 그 위치에 덮어씁니다. 즉, 기존 `package.json`과 새 `package.json`이 같은 폴더에 있어야 합니다.
5. 기존 `.env` 파일은 덮어쓰지 말고, API 키/VAPID 비밀키를 GitHub에 업로드하지 않습니다. `.env.example`만 필요한 경우 갱신합니다.
6. GitHub에 commit/push하면 Render가 재배포합니다. 기존 환경변수와 Persistent Disk는 그대로 유지합니다.

기존 Render 환경변수 `DATABASE_PATH`가 `/var/data/mythic-shop.sqlite`를 가리키고, 해당 경로에 Persistent Disk가 연결되어 있는지 확인하세요. 기존 DB가 영구 디스크에 있다면 서버 시작 시 기존 상품과 판매 이력을 Master Pool로 이전한 뒤 159개 후보를 중복 키 기준으로 병합합니다.

기존 `ITEMSHOP_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`는 다시 만들거나 ZIP에 입력할 필요가 없습니다.

## 배포 후 확인

- 앱 화면: `https://서비스주소.onrender.com/`
- Master Pool 및 병합 상세: `https://서비스주소.onrender.com/api/catalog`
- 서버 상태: `https://서비스주소.onrender.com/api/health`
- 푸시 설정 여부: `https://서비스주소.onrender.com/api/config`
- 한국어 검색 별칭: `https://서비스주소.onrender.com/api/search-aliases`
- 새로고침 강제 갱신 결과: `https://서비스주소.onrender.com/api/shop/today?force=1`

`/api/search-aliases` 응답에서 `localizedCount`, `itemCount`, `unmatchedCount`, `generatedChromaCount`를 확인합니다. `localizedCount`는 한국어 글자가 포함된 검색 별칭을 만든 상품 수이고, `unmatchedCount`는 한국어 이름을 생성하지 못한 상품 수입니다. 최초 생성 시에는 CommunityDragon의 한국어 데이터 파일을 가져오므로 첫 요청에 시간이 더 걸릴 수 있으며, 생성된 별칭은 SQLite에 캐시됩니다.

새로고침 버튼은 `force=1` 요청으로 외부 itemshop.gg 상점 API를 직접 다시 호출합니다. 응답의 `refresh.updated`가 `true`면 서버가 이번 요청에서 정상 상점 응답을 받아 DB를 갱신한 것입니다. `refresh.stale`가 `true`이거나 `refresh.error`가 있으면 실패 상태이고 이전 정상 스냅샷을 보존합니다.

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
- `GET /api/search-aliases`: Master Pool 각 상품의 한국어 검색 별칭
- `GET /api/preferences/:deviceId`: 기기별 즐겨찾기 및 푸시 구독 상태
- `PUT /api/preferences/:deviceId`: 기기별 즐겨찾기 저장
- `POST /api/push/subscribe`: 이 기기의 푸시 알림 켜기
- `DELETE /api/push/subscribe/:deviceId`: 이 기기의 푸시 알림 끄기
- `POST /api/push/test`: 테스트 알림 전송
- `GET /api/health`: 서버 상태
- `GET /api/config`: 서버 VAPID 설정 여부 및 공개키

- 로테이션 감지: itemshop.gg `/api/v1/rotations`를 1분마다 확인하고 fingerprint가 바뀌면 상점 API를 즉시 다시 수집합니다.
- 상점 갱신 안전망: 마지막 성공 수집 후 5분이 지나면 서버 스케줄러 또는 `/api/shop/today` 요청에서 다시 수집합니다. 실패한 경우 다음 5분 주기에 재시도합니다.
- 앱 화면: 앱이 열려 있는 동안 5분마다 자동 갱신하고, 탭/앱으로 돌아올 때도 서버의 최신 스냅샷을 확인합니다. 사용자가 새로고침 버튼을 누르면 `force=1`로 외부 상점 API를 직접 재호출합니다.
- 캐시 방지: `/api/*` 응답에 `Cache-Control: no-store`를 적용해 브라우저가 이전 상점 JSON을 재사용하지 않게 합니다.
- KST 날짜 변경: 마지막 성공 수집이 오늘 날짜가 아니면 다음 앱 요청/예약 점검에서 다시 수집합니다. LoL 상점은 고정된 자정 초기화가 아니므로 자정만을 유일한 갱신 트리거로 사용하지 않습니다.
- 과거 이력 백필: 서버 시작 시 및 매일 00:20 KST
- 푸시: 즐겨찾기된 상품의 `itemKey`가 새 로테이션에서 나타날 때, 알림이 켜진 기기에만 전송

## v1.5.1 상점 자동 갱신 및 v1.5.2 수동 갱신

### 자동 갱신이 멈췄을 때

1. `GET /api/health`를 열어 `lastShopSync`, `lastShopSyncAgeMs`, `shopSyncError`, `rotationCheckedAt`, `rotationCheckError`를 확인합니다.
2. `lastShopSyncAgeMs`가 300000보다 크면 5분 이상 새로 수집되지 않은 것입니다. 앱의 새로고침 버튼은 `GET /api/shop/today?force=1`을 호출해 캐시 신선도 조건을 우회하고 외부 상점 API를 즉시 다시 요청합니다. 동시 요청은 하나로 합쳐지며, 별도의 60초 수동 제한은 없습니다.
3. `shopSyncError`가 있으면 Render의 Logs에서 `[shop]` 오류를 확인하고, `rotationCheckError`가 있으면 `[rotations]` 오류를 확인합니다.
4. `GET /api/shop/today` 응답의 `shop.stale`이 `true`라면 upstream API가 오래된 응답을 반환했거나 최신 요청에 실패한 상태이므로, 기존 마지막 정상 스냅샷을 보여줍니다.

### Render 실행 플랜 주의

- Render Free Web Service는 요청이 15분 동안 없으면 sleep 상태가 되며, 잠든 동안 Node.js의 `setInterval`과 `node-cron`은 실행되지 않습니다. 앱을 다시 열면 요청 기반 신선도 확인이 상점을 다시 가져옵니다.
- Render Free Web Service는 Persistent Disk를 연결할 수 없습니다. 이 앱은 SQLite를 사용하므로, 즐겨찾기·구독·상점 DB를 계속 보존하려면 유료 Web Service와 `/var/data` Persistent Disk(환경변수 `DATABASE_PATH=/var/data/mythic-shop.sqlite`) 구성이 필요합니다.
- 앱을 사용하지 않는 시간에도 푸시 로테이션 감지를 지속하려면 서버가 계속 실행 중이어야 합니다. Render Free에서 sleep 중에는 서버 측 푸시 감지도 중단됩니다.

## 출처 및 데이터 이용

- [itemshop.gg LoL 카탈로그](https://itemshop.gg/league-of-legends/catalogue) — 2026-11-18 기준 Mythic rarity / SKIN 필터
- [itemshop.gg LoL 상점](https://itemshop.gg/league-of-legends) — 현재 상점 및 상품 출처
- [itemshop.gg API 문서](https://itemshop.gg/developers)
- [itemshop.gg 이용 약관](https://itemshop.gg/terms#api)
- [Riot Data Dragon](https://developer.riotgames.com/docs/lol#data-dragon) — 공식 한국어 챔피언/스킨 데이터 및 버전별 현지화 리소스
- [CommunityDragon 한국어 게임 데이터](https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/ko_kr/v1/) — 스킨, 감정표현, 소환사 아이콘, 와드 스킨 현지화 이름

이 프로젝트는 팬 제작 도구이며 Riot Games와 공식 제휴·승인을 받은 앱이 아닙니다.

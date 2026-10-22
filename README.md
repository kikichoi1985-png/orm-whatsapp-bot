# O'rm 영수증 비서 (WhatsApp PoC)

직원이 WhatsApp으로 영수증 사진이나 PDF를 **비서 번호에 1:1로** 보내면 Claude가 읽고, 현업 규칙(B01~B03)대로 장부 후보를 만들어요. 직원이 버튼으로 확인하면 Google Sheets 장부에 저장돼요.

```
직원 WhatsApp ──사진/PDF──▶ Meta Cloud API ──웹훅──▶ 이 서버 (Render)
                                                     ├─ Claude: 판독 (날짜·거래처·품목·금액)
                                                     ├─ 규칙: 분류 B02 · CNY 환산 B03 · 선지불 REF B01
직원 WhatsApp ◀──후보 + [저장][분류 변경][버리기]─────┤
                                                     └─ Google Sheets: Ledger 탭에 한 줄 추가
```

## 직원이 쓰는 법

| 하는 일 | 보내는 것 |
|---|---|
| 영수증 등록 | 사진이나 PDF. 개인 돈으로 냈으면 캡션에 `선지불` |
| 틀린 값 고치기 | 후보에 답장하기 (예: `총액 1,200`, `날짜 10/20`) |
| 분류 바꾸기 | [분류 변경] 버튼 |
| 저장 | [저장] 버튼 → 장부에 한 줄 추가 |
| 선지불 입금 완료 | `INV-208431 입금완료` 또는 `R261022-K7Q 입금완료` |
| 사용법 보기 | `도움말` |

AI가 영수증을 못 읽으면 보낸 사람에게 질문하고, 답장을 반영해 다시 읽어요.

---

## 설치 (처음 한 번, 약 1~2시간)

준비물: Meta Business 계정, 신용카드(Anthropic 크레딧용), Google 계정, GitHub 계정

### 1. Meta: WhatsApp 테스트 번호 받기
1. https://developers.facebook.com → **내 앱 → 앱 만들기** → 사용 사례에서 **WhatsApp 비즈니스 메시지**를 고르고, 기존 Meta Business 계정을 연결하세요.
2. 왼쪽 **WhatsApp → API 설정**으로 가세요.
   - **테스트 전화번호**가 자동으로 생겨요. 아래 두 값을 적어 두세요.
     - **임시 액세스 토큰** → `WHATSAPP_TOKEN` (24시간 뒤 만료돼요. 영구 토큰은 9단계 참고)
     - **전화번호 ID** → `WHATSAPP_PHONE_NUMBER_ID` (전화번호가 아니라 숫자 ID예요)
   - **받는 사람(To)**에 테스트할 직원 휴대폰 번호를 최대 5개까지 등록하고 인증 코드로 확인하세요.
3. **앱 설정 → 기본 설정 → 앱 시크릿** → `WHATSAPP_APP_SECRET`

### 2. Anthropic API 키
https://console.anthropic.com → **API Keys → Create Key** → `ANTHROPIC_API_KEY`. Billing에서 크레딧 $10~20을 충전하세요(영수증 1장에 약 1~2센트).

### 3. Google Sheets 장부 연결
1. **PoC 전용 새 스프레드시트**를 만들고 URL의 `/d/`와 `/edit` 사이 문자열을 적어 두세요 → `GOOGLE_SHEET_ID`. 실제 회계장부는 검증이 끝날 때까지 건드리지 않아요.
2. https://console.cloud.google.com → 새 프로젝트를 만드세요.
   - **API 및 서비스 → 라이브러리**에서 **Google Sheets API**를 사용 설정하세요.
   - **사용자 인증 정보 → 서비스 계정 만들기** → 서비스 계정의 **키 → 키 추가 → JSON**을 받으세요.
3. 받은 JSON 파일 내용을 전부 `GOOGLE_SERVICE_ACCOUNT_JSON`에 넣으세요.
4. 1번 스프레드시트를 **서비스 계정 이메일**(`...@...iam.gserviceaccount.com`)과 **편집자**로 공유하세요.
   - `Ledger`, `Vendors`, `Config` 탭은 서버가 처음 켜질 때 자동으로 만들어요.

### 4. 코드를 GitHub에 올리기
GitHub에서 **New repository** → **Private** → 만든 뒤 "uploading an existing file"을 누르고 이 폴더의 파일을 끌어다 놓으세요. `node_modules` 폴더와 `.env` 파일은 올리지 마세요.

### 5. Render에 배포
1. https://render.com → **New → Web Service** → 4번 저장소를 연결하세요.
2. 아래처럼 설정하세요.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: **Starter** 권장. Free는 잠들어서 첫 메시지 답이 1분 가까이 늦어요.
3. **Environment**에 `.env.example`의 항목을 모두 넣으세요.
   - `WHATSAPP_VERIFY_TOKEN`은 아무 문자열이나 직접 정하면 돼요. 예: `orm-verify-2026`
   - `ALLOWED_NUMBERS`에는 직원 번호를 넣으세요. 예: `85291234567`
4. 배포가 끝나면 `https://<이름>.onrender.com`을 열어 "O'rm 영수증 비서 실행 중"이 보이는지 확인하세요.
5. **Logs**에 "장부 시트 확인 완료"가 나오면 시트 연결도 된 거예요.

### 6. Meta 웹훅 연결
WhatsApp → **구성(Configuration) → 웹훅**에서 아래처럼 설정하세요.
- 콜백 URL: `https://<이름>.onrender.com/webhook`
- 확인 토큰: 5단계에서 정한 `WHATSAPP_VERIFY_TOKEN`
- **확인 및 저장**을 누른 뒤 웹훅 필드에서 **messages**를 **구독**하세요.

### 7. 첫 테스트
1. 등록한 직원 폰에서 테스트 번호로 `도움말`을 보내 사용법 답장이 오는지 확인하세요.
2. 영수증 사진을 캡션 `선지불`과 함께 보내 보세요.
3. 후보가 오면 [저장]을 누르고, Ledger 탭에 한 줄이 생겼는지 확인하세요.
4. `영수증번호 입금완료`를 보내 REF가 바뀌는지 확인하세요.

### 8. 기준정보·환율 관리 (시트에서 직접)
- **Vendors 탭**: 거래처 이름과 주 취급 품목(Food/Drink/Mixed/Other)을 적어요. 품목이 불분명할 때 분류 기준이 돼요(B02 규칙 2).
- **Config 탭**: `CNY_HKD` 환율이에요. 1분 안에 반영돼요. **적용 날짜·고시값·반올림 기준은 D12·D13 확정이 필요해요.**

### 9. 실제 운영 번호로 바꾸기 (PoC 중반 이후)
- 실제 번호 추가: 이 번호는 WhatsApp 앱에서 쓰던 번호가 아니어야 해요. 새 번호를 쓰거나, 기존 번호의 계정을 지워야 해요.
- 비즈니스 인증과 표시 이름 승인을 받고, 결제 수단을 등록하세요.
- **시스템 사용자 영구 토큰**을 발급해 `WHATSAPP_TOKEN`을 교체하세요. Business 설정 → 시스템 사용자 → 토큰 생성 → `whatsapp_business_messaging` 권한을 주면 돼요.

---

## 알아둘 점
- **기존 단톡방은 읽지 않아요.** 공식 API로는 기존 그룹에 봇을 넣을 수 없어요. 그래서 직원이 단톡방에 올리던 영수증을 비서 번호로 **전달(Forward)** 하면 돼요.
- **비용**
  - Meta: 직원이 먼저 보낸 대화에 24시간 안에 답하는 서비스 메시지는 번호당 월 1,000건 무료예요(2026-10-01부터). 그 이후는 건당 과금이에요.
  - Claude: 영수증 1장에 약 1~2센트예요.
- **확인 전 후보는 서버 메모리에 있어요.** 서버가 재시작되면 아직 [저장]하지 않은 후보는 사라져요(다시 보내면 돼요). 저장된 장부는 시트에 있어서 안전해요.
- **장부 열 구성(`src/sheets.js`의 `LEDGER_HEADERS`)은 임시예요.** '09_장부 필드 정의' 탭에 맞춰 바꿔야 해요.
- 지금은 보낸 사람이 직접 [저장]해요. 대표 승인 단계가 필요하면 다음 버전에 추가할 수 있어요(B05·B07과 함께).

## 개발자용
```
npm install
npm test            # 규칙 + 가짜 WhatsApp/Claude/Sheets로 대화 흐름 16개 테스트
npm start           # .env 값이 환경변수로 있어야 함
```
| 파일 | 역할 |
|---|---|
| `src/rules.js` | B01~B03 현업 규칙 (순수 함수) |
| `src/flow.js` | 대화 흐름 |
| `src/extract.js` | Claude 판독 프롬프트와 스키마 |
| `src/whatsapp.js` | Cloud API (전송, 미디어, 웹훅 파싱, 서명 검증) |
| `src/sheets.js` | 장부 저장소 |

// Claude로 영수증/인보이스 판독 (B01). 구조화 출력은 강제 tool 호출로 받는다.
import Anthropic from '@anthropic-ai/sdk';

const TOOL = {
  name: 'record_receipt',
  description: '영수증/인보이스에서 읽은 장부 입력 후보를 기록한다.',
  input_schema: {
    type: 'object',
    properties: {
      readable: { type: 'boolean', description: '영수증이며 날짜·거래처·총액을 모두 읽을 수 있으면 true' },
      question: { type: 'string', description: 'readable=false일 때 올린 사람에게 보낼 짧고 구체적인 한국어 질문. 빠진 필수값(날짜·거래처·총액, 품목을 전혀 알 수 없을 때만 품목)만 묻는다' },
      missing: { type: 'array', items: { type: 'string', enum: ['date', 'vendor', 'total', 'items'] }, description: 'readable=false일 때 읽지 못한 필수값' },
      doc_type: { type: 'string', enum: ['receipt', 'invoice', 'credit_note', 'payment_slip', 'statement', 'other'], description: '증빙 종류. 송금·입금 확인 화면은 payment_slip' },
      related_no: { type: 'string', description: 'Credit Note·수정 인보이스·statement가 가리키는 원래 인보이스 번호(여러 개면 쉼표), 없으면 빈 문자열' },
      purpose: { type: 'string', description: '구매 목적·용도 (메시지에 있으면 그대로 짧게, 예: Staff meal, Team Building). 없으면 빈 문자열 — 추측 금지' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      vendor: { type: 'string' },
      receipt_no: { type: 'string', description: '영수증/인보이스 번호, 없으면 빈 문자열' },
      currency: { type: 'string', description: 'ISO 코드. ¥/元/RMB=CNY, 홍콩 영수증의 $/HK$=HKD' },
      total: { type: 'number', description: '최종 결제 총액' },
      payment_method: { type: 'string', description: '현금/카드/이체/Alipay 등, 모르면 빈 문자열' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '품목명만' },
            qty: { type: 'string', description: '수량 (단위 포함 가능)' },
            amount: { type: 'number', description: '그 품목의 결제금액' },
            category: { type: 'string', enum: ['Food', 'Drink', 'Meal', 'Other', 'Unclear'] },
          },
          required: ['name', 'category'],
        },
      },
      notes: { type: 'string', description: '추측한 값이 있으면 짧게 (한국어)' },
      mismatch: { type: 'string', description: '같은 구매의 첨부끼리 금액이 맞지 않으면 무엇이 얼마나 다른지 짧게(한국어). 맞으면 빈 문자열' },
      receipts: {
        type: 'array',
        description: '사진·PDF 한 장에 서로 다른 영수증이 2장 이상이면 영수증마다 하나씩(합치지 않음). 1장이면 비운다.',
        items: {
          type: 'object',
          properties: {
            doc_type: { type: 'string' }, date: { type: 'string' }, vendor: { type: 'string' }, receipt_no: { type: 'string' },
            currency: { type: 'string' }, total: { type: 'number' }, payment_method: { type: 'string' }, purpose: { type: 'string' },
            items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string', enum: ['Food', 'Drink', 'Meal', 'Other', 'Unclear'] } }, required: ['name', 'category'] } },
            notes: { type: 'string' },
          },
          required: ['total', 'items'],
        },
      },
    },
    required: ['readable', 'items'],
  },
};

export function buildPrompt({ sender, message, answers = [], vendors = [], today, part = null }) {
  const vendorList = vendors.map((v) => `${v.name} (${v.type})`).join(', ') || '없음';
  return `너는 홍콩 F&B 회사 O'rm의 회계 보조다. 직원이 WhatsApp으로 보낸 영수증/인보이스(첨부)와 메시지를 읽고 장부 입력 후보를 record_receipt 도구로 기록한다.

규칙
- items에는 품목명과 수량만(가격·설명 제외). 품목명은 영수증에 찍힌 표기 그대로 쓴다(약어도 그대로, 번역·풀이·괄호 설명·'추정' 금지 — 풀이가 필요하면 notes에). amount는 그 품목의 결제금액(영수증 통화 숫자).
- 한 사진·PDF에 서로 다른 영수증(영수증번호·결제가 따로인 것)이 2장 이상이면 절대 합산하지 않는다. receipts에 영수증마다 하나씩 기록하고, 맨 위 필드에는 첫 번째 영수증을 기록한다.
- category: Food(가게에서 쓸 식재료·식품을 산 것), Drink(가게에서 쓸 음료·주류·커피/차 원료를 산 것), Meal(식당·카페·바·배달앱에서 사 먹고 마신 음식·음료 — 회식·접대·회의·직원 식대. 식재료 구매가 아님), Other(소모품·포장재·교통·수리·공과금·비품 등), Unclear(판독 불가 또는 무엇인지 모름).
  예: 스타벅스 커피·식당 점심·바 계산서·Keeta 배달 = Meal / 치즈·생선·과일을 마켓에서 구매 = Food / 와인 도매 구매 = Drink.
  품목이 없는 카드 전표·결제 문자라도 가게 이름이 식당·카페·바면 Meal로 둔다.
- 영수증이 아니거나 날짜·거래처·총액 중 하나라도 읽을 수 없으면 readable=false로 하고 missing에 빠진 값을 적고, question에는 그 빠진 값만 묻는다. 품목이 영수증에 보이면 품목·용도(구매 목적)는 묻지 않는다 — 용도는 선택 정보다. 읽은 값(거래처·총액·품목 등)은 readable=false여도 해당 칸에 채워 둔다. 올린 사람의 추가 답변·정정이 있으면 반드시 그대로 반영한다(답변이 우선).
- 연도가 없으면 오늘(${today}) 기준으로 가장 최근 날짜로 본다.
- 월별 거래명세서(Statement)는 doc_type=statement. total은 그 기간에 새로 생긴 구매액(Current Month·당월 인보이스 합계)이고, 이월 잔액(B/F·Opening)·최종 잔액(Balance)·입금액은 넣지 않는다. date는 기간 마지막 날. receipt_no는 statement 번호가 있으면 그 번호, 없으면 '<거래처 짧은 이름> YYYY-MM Statement'. items는 'YYYY-MM Statement (인보이스 N건)' 한 줄(category Unclear)로 하고, 인보이스 번호들은 related_no에 쉼표로 적는다.
- Credit Note는 doc_type=credit_note, total은 차감 금액(양수), related_no에 원래 인보이스 번호.
- 가격표·견적·상품 사진·결제 전 장바구니처럼 거래 증빙이 아니면 doc_type=other로 표시하고 notes에 무엇인지 쓴다.
- 은행 송금·이체 확인 화면은 doc_type=payment_slip(금액·날짜·받는 사람은 채운다).
- 카드 결제 알림 문자·카드 전표·주문 완료 화면은 가게에서 결제한 기록이므로 doc_type=receipt로 본다.
- 품목을 증빙에서 알 수 없으면 메시지의 설명으로 items를 채운다(예: "MS 이벤트 극세사 린넨 / refractometer"). 메시지에도 무엇을 샀는지 설명이 없으면 readable=false로 하고 무엇을 샀는지(품목·용도)를 묻는다. 품목을 추측해 만들지 않는다.
- 첨부가 여러 개면 같은 직원이 연달아 보낸 것이다. 같은 구매의 증빙끼리(예: 타오바오 장바구니·주문 화면 + 은행 카드 결제 문자)는 하나로 합쳐 기록한다: 품목·수량은 주문 화면에서, 날짜·결제 금액·통화는 실제 결제 증빙(카드 문자·영수증)에서 가져온다. 주문 화면의 금액은 notes에 원래 통화 그대로 적는다. 두 금액이 환율을 감안해도 맞지 않으면 mismatch에 적는다. 서로 다른 구매면 receipts에 따로 기록한다.
- 신분증·여권·은행 계좌 화면 등 개인정보 문서면 doc_type=other로 하고, 이름·번호 등 개인정보는 어떤 칸에도 옮겨 적지 않는다(notes에는 "신분증" 같은 종류만).

알려진 거래처(기준정보): ${vendorList}
올린 사람: ${sender || '(이름 없음)'}
메시지/캡션: ${message || '(없음)'}
${answers.length ? '올린 사람의 추가 답변·정정:\n' + answers.map((a) => '- ' + a).join('\n') : ''}${part ? `\n\n이 사진에는 영수증이 ${part.total}장 있다. 그중 ${part.index}번째 영수증(영수증번호 ${part.receiptNo || '없음'}, 총액 ${part.amount ?? '?'})만 기록하고 receipts는 비운다.` : ''}`;
}

export function createExtractor({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  return async function extract({ media, sender, message, answers, vendors, part }) {
    const files = Array.isArray(media) ? media : [media];
    const toBlock = (m) => (m.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: m.mimeType, data: m.base64 } });
    const fileBlocks = files.map(toBlock);
    const prompt = buildPrompt({ sender, message, answers, vendors, part, today: new Date().toISOString().slice(0, 10) })
      + '\n\n반드시 record_receipt 도구를 한 번 호출해서 결과를 기록하라. 도구 호출 외의 설명은 쓰지 않는다.';
    const call = (toolChoice) => client.messages.create({
      model,
      max_tokens: 4000,
      tools: [TOOL],
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages: [{ role: 'user', content: [...fileBlocks, { type: 'text', text: prompt + (files.length > 1 ? `\n\n첨부 ${files.length}개를 함께 보고 판단하라.` : '') }] }],
    });
    let res;
    try {
      res = await call({ type: 'tool', name: TOOL.name });
    } catch (e) {
      // 일부 모델은 도구 호출 강제(tool/any)를 지원하지 않음 → 자동 선택으로 재시도
      if (e?.status === 400 && /tool_choice/i.test(e.message)) res = await call(null);
      else throw e;
    }
    return parseResult(res);
  };
}

/** 응답에서 record_receipt 결과를 꺼낸다. 도구 호출이 없으면 본문의 JSON을 시도. */
export function parseResult(res) {
  const use = (res.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  if (use) return use.input;
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* 아래에서 오류 */ } }
  throw new Error('Claude가 구조화 결과를 반환하지 않음');
}

export const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

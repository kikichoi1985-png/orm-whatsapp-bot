// Claude로 영수증/인보이스 판독 (B01). 구조화 출력은 강제 tool 호출로 받는다.
import Anthropic from '@anthropic-ai/sdk';

const TOOL = {
  name: 'record_receipt',
  description: '영수증/인보이스에서 읽은 장부 입력 후보를 기록한다.',
  input_schema: {
    type: 'object',
    properties: {
      readable: { type: 'boolean', description: '영수증이며 날짜·거래처·총액을 모두 읽을 수 있으면 true' },
      question: { type: 'string', description: 'readable=false일 때 올린 사람에게 보낼 짧고 구체적인 한국어 질문' },
      doc_type: { type: 'string', enum: ['receipt', 'invoice', 'credit_note', 'payment_slip', 'statement', 'other'], description: '증빙 종류. 송금·입금 확인 화면은 payment_slip' },
      related_no: { type: 'string', description: 'Credit Note·수정 인보이스가 가리키는 원래 인보이스 번호, 없으면 빈 문자열' },
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
            category: { type: 'string', enum: ['Food', 'Drink', 'Other', 'Unclear'] },
          },
          required: ['name', 'category'],
        },
      },
      notes: { type: 'string', description: '추측한 값이 있으면 짧게 (한국어)' },
    },
    required: ['readable', 'items'],
  },
};

export function buildPrompt({ sender, message, answers = [], vendors = [], today }) {
  const vendorList = vendors.map((v) => `${v.name} (${v.type})`).join(', ') || '없음';
  return `너는 홍콩 F&B 회사 O'rm의 회계 보조다. 직원이 WhatsApp으로 보낸 영수증/인보이스(첨부)와 메시지를 읽고 장부 입력 후보를 record_receipt 도구로 기록한다.

규칙
- items에는 품목명과 수량만(가격·설명 제외). amount는 그 품목의 결제금액(영수증 통화 숫자).
- category: Food(식재료·식품), Drink(음료·주류·커피/차 원료), Other(소모품·포장재·교통·비품 등 식음료가 아닌 것), Unclear(판독 불가 또는 무엇인지 모름).
- 영수증이 아니거나 날짜·거래처·총액 중 하나라도 읽을 수 없으면 readable=false, question에 질문을 쓴다. 올린 사람의 추가 답변·정정이 있으면 반드시 그대로 반영한다(답변이 우선).
- 연도가 없으면 오늘(${today}) 기준으로 가장 최근 날짜로 본다.
- Credit Note는 doc_type=credit_note, total은 차감 금액(양수), related_no에 원래 인보이스 번호.
- 가격표·견적·상품 사진처럼 거래 증빙이 아니면 doc_type=other, 송금·입금 확인 화면은 doc_type=payment_slip으로 표시하고 notes에 무엇인지 쓴다.

알려진 거래처(기준정보): ${vendorList}
올린 사람: ${sender || '(이름 없음)'}
메시지/캡션: ${message || '(없음)'}
${answers.length ? '올린 사람의 추가 답변·정정:\n' + answers.map((a) => '- ' + a).join('\n') : ''}`;
}

export function createExtractor({ apiKey, model }) {
  const client = new Anthropic({ apiKey });
  return async function extract({ media, sender, message, answers, vendors }) {
    const fileBlock = media.mimeType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.base64 } }
      : { type: 'image', source: { type: 'base64', media_type: media.mimeType, data: media.base64 } };
    const res = await client.messages.create({
      model,
      max_tokens: 2000,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{
        role: 'user',
        content: [fileBlock, { type: 'text', text: buildPrompt({ sender, message, answers, vendors, today: new Date().toISOString().slice(0, 10) }) }],
      }],
    });
    const use = res.content.find((b) => b.type === 'tool_use');
    if (!use) throw new Error('Claude가 구조화 결과를 반환하지 않음');
    return use.input;
  };
}

export const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];

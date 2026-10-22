// 가짜 WhatsApp / Claude / Sheets로 실제 대화 흐름을 끝까지 시뮬레이션
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/flow.js';
import { parseWebhook, verifySignature } from '../src/whatsapp.js';
import crypto from 'node:crypto';

function harness(extractImpl) {
  const sent = [];
  const ledger = [];
  const wa = {
    sendText: async (to, body) => sent.push({ to, kind: 'text', body }),
    sendButtons: async (to, body, buttons) => sent.push({ to, kind: 'buttons', body, buttons }),
    sendList: async (to, body, _b, rows) => sent.push({ to, kind: 'list', body, rows }),
    markRead: () => {},
    downloadMedia: async () => ({ base64: 'AAAA', mimeType: 'image/jpeg' }),
  };
  const sheets = {
    getVendors: async () => [{ name: 'Classic Fine Foods', type: 'Food' }],
    getConfig: async () => ({ CNY_HKD: '1.09' }),
    appendLedger: async (row) => { ledger.push({ ...row }); },
    listLedger: async () => ledger.map((r, i) => ({ rowNumber: i + 2, id: r.ID, receiptNo: r.영수증번호, ref: r.REF, vendor: r.거래처, hkd: r.HKD, uploader: r.올린사람 })),
    markPaid: async (rowNumber, { ref, reportedBy }) => { Object.assign(ledger[rowNumber - 2], { REF: ref, 입금보고자: reportedBy }); },
  };
  const calls = [];
  const extract = async (args) => { calls.push(args); return extractImpl(args, calls.length); };
  const bot = createBot({ wa, extract, sheets, allowed: ['85291110000', '85292220000'], log: { warn() {}, error() {} } });
  let n = 0;
  const send = (m) => bot.handle({ id: 'm' + (++n), from: '85291110000', name: 'Mina', type: 'text', ...m });
  const last = () => sent.at(-1);
  return { bot, sent, ledger, calls, send, last };
}

const CFF = {
  readable: true, date: '2026-10-20', vendor: 'CLASSIC FINE FOODS (HK) LTD', receipt_no: 'INV-208431', currency: 'HKD', total: 1075,
  payment_method: 'VISA', items: [
    { name: 'Unsalted Butter 1kg', qty: '2', amount: 336, category: 'Food' },
    { name: 'Whipping Cream', qty: '3', amount: 255, category: 'Food' },
    { name: 'Parmigiano', qty: '1', amount: 298, category: 'Food' },
    { name: 'San Pellegrino', qty: '24', amount: 186, category: 'Drink' },
  ],
};

test('영수증(선지불) → 후보 → 저장 → 입금완료 REF 갱신', async () => {
  const h = harness(() => CFF);
  await h.send({ type: 'image', mediaId: 'media1', mimeType: 'image/jpeg', text: '선지불 급하게 샀어요' });
  const card = h.last();
  assert.equal(card.kind, 'buttons');
  assert.match(card.body, /Purchase_Food/);
  assert.match(card.body, /HKD 1,075.00/);
  assert.match(card.body, /Mina 선지불, 추후 입금 해야함/);

  await h.send({ type: 'interactive', replyId: card.buttons[0].id });
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].분류, 'Purchase_Food');
  assert.equal(h.ledger[0].HKD, 1075);
  assert.equal(h.ledger[0].REF, 'Mina 선지불, 추후 입금 해야함');
  assert.equal(h.ledger[0].AI대비수정, '없음');
  assert.match(h.last().body, /입금완료/);

  // 다른 직원(대표)이 입금 완료 보고 — 이름은 원래 선지불한 사람 기준
  await h.bot.handle({ id: 'x1', from: '85292220000', name: '대표', type: 'text', text: 'INV-208431 입금완료' });
  assert.equal(h.ledger[0].REF, 'Mina 선지불, 추후 입금완료');
  assert.equal(h.ledger[0].입금보고자, '대표');
});

test('판독 불가 → 질문 → 답변 반영 → 후보', async () => {
  const h = harness((args, n) => n === 1
    ? { readable: false, question: '총액이 흐려요. 얼마였나요?', items: [] }
    : { ...CFF, total: Number(args.answers[0].replace(/\D/g, '')) });
  await h.send({ type: 'image', mediaId: 'm', mimeType: 'image/png', text: '' });
  assert.match(h.last().body, /총액이 흐려요/);
  await h.send({ text: '1200' });
  assert.deepEqual(h.calls[1].answers, ['1200']);
  assert.equal(h.last().kind, 'buttons');
  assert.match(h.last().body, /HKD 1,200.00/);
});

test('정정 답장 → 재판독, 분류 직접 변경 → 저장 시 수정 항목 기록', async () => {
  const h = harness((args) => args.answers.length ? { ...CFF, total: 999 } : CFF);
  await h.send({ type: 'image', mediaId: 'm', mimeType: 'image/jpeg', text: '' });
  const id = h.last().buttons[0].id.split(':')[1];
  await h.send({ text: '총액 999' });
  assert.match(h.last().body, /HKD 999.00/);
  await h.send({ type: 'interactive', replyId: `cat:${id}` });
  assert.equal(h.last().kind, 'list');
  await h.send({ type: 'interactive', replyId: `set:${id}:Expenses` });
  assert.match(h.last().body, /Expenses \(SG&A\)/);
  await h.send({ type: 'interactive', replyId: `save:${id}` });
  assert.equal(h.ledger[0].분류, 'Expenses (SG&A)');
  assert.equal(h.ledger[0].REF, '');
  assert.match(h.ledger[0].AI대비수정, /원금액/);
  assert.match(h.ledger[0].AI대비수정, /분류/);
});

test('CNY 영수증 환산 + "선지불"을 사진보다 먼저 보낸 경우', async () => {
  const h = harness(() => ({ readable: true, date: '2026-10-18', vendor: '淘宝 Taobao', receipt_no: '3984475120021', currency: 'CNY', total: 276.6,
    items: [{ name: '一次性丁腈手套', qty: '5', amount: 145, category: 'Other' }, { name: '厨房纸巾', qty: '10', amount: 89.9, category: 'Other' }] }));
  await h.send({ text: '선지불' });
  assert.match(h.last().body, /선지불로 표시/);
  await h.send({ type: 'image', mediaId: 'm', mimeType: 'image/jpeg', text: '' });
  assert.match(h.last().body, /CNY 276.60 → HKD 301.49 \(@1.09/);
  assert.match(h.last().body, /Expenses/);
  assert.match(h.last().body, /선지불, 추후 입금 해야함/);
});

test('허용 안 된 번호 무시, 중복 웹훅 무시, 지원 안 되는 파일 안내', async () => {
  const h = harness(() => CFF);
  await h.bot.handle({ id: 'z', from: '85299999999', name: '?', type: 'text', text: '도움말' });
  assert.equal(h.sent.length, 0);
  await h.send({ type: 'image', mediaId: 'm', mimeType: 'image/jpeg', text: '' });
  const count = h.sent.length;
  await h.bot.handle({ id: 'm1', from: '85291110000', type: 'image', mediaId: 'm', mimeType: 'image/jpeg' }); // 같은 id 재전송
  assert.equal(h.sent.length, count);
  await h.send({ type: 'document', mediaId: 'd', mimeType: 'application/vnd.ms-excel', text: '' });
  assert.match(h.last().body, /PDF/);
});

test('웹훅 파싱과 서명 검증', () => {
  const body = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '852911', profile: { name: 'Mina' } }],
    messages: [
      { id: 'a', from: '852911', timestamp: '1', type: 'image', image: { id: 'IMG', mime_type: 'image/jpeg', caption: '선지불' } },
      { id: 'b', from: '852911', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'save:R1', title: '저장' } } },
    ] } }] }] };
  const [a, b] = parseWebhook(body);
  assert.equal(a.mediaId, 'IMG'); assert.equal(a.text, '선지불'); assert.equal(a.name, 'Mina');
  assert.equal(b.replyId, 'save:R1');
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.ok(verifySignature(raw, sig, 's3cret'));
  assert.ok(!verifySignature(raw, sig, 'wrong'));
});

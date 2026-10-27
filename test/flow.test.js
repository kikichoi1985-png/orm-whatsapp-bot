// 가짜 WhatsApp / Claude / Sheets / 환율로 실제 대화 흐름을 끝까지 시뮬레이션
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBot } from '../src/flow.js';
import { parseWebhook, verifySignature } from '../src/whatsapp.js';
import { CATEGORIES } from '../src/rules.js';

const STAFF = '85291110000';   // 한상훈 매니져님 (직원)
const ACCT = '85292220000';    // 고성찬 (회계)

function harness(extractImpl, { approvers = true, fxImpl, failWindow = false, ledgerSeed = {} } = {}) {
  const sent = [];
  const tabs = Object.fromEntries(Object.values(CATEGORIES).map((t) => [t, [['No.'], ...(ledgerSeed[t] || [])]]));
  const log = [];
  let windowClosed = failWindow;
  const wa = {
    sendText: async (to, body) => sent.push({ to, kind: 'text', body }),
    sendButtons: async (to, body, buttons) => {
      if (windowClosed && to === ACCT) { const e = new Error('Re-engagement message'); e.code = 131047; throw e; }
      sent.push({ to, kind: 'buttons', body, buttons });
    },
    sendList: async (to, body, _b, rows) => sent.push({ to, kind: 'list', body, rows }),
    sendTemplate: async (to, name) => sent.push({ to, kind: 'template', name }),
    markRead: () => {},
    downloadMedia: async () => ({ base64: 'AAAA', mimeType: 'image/jpeg' }),
  };
  const rowsOf = (tab) => tabs[tab].map((r, i) => ({ r, i })).filter(({ r }) => String(r[0]).startsWith('#')).map(({ r, i }) => ({
    tab, rowNumber: i + 1, no: r[0], file: r[1], receiptNo: r[2], date: r[3], vendor: r[4], currency: r[5], details: r[6], amount: r[7], hkd: r[8], payDate: r[9], account: r[10], ref: r[11] || '',
  }));
  const sheets = {
    getStaff: async () => [
      { phone: STAFF, name: '한상훈 매니져님', role: '직원' },
      ...(approvers ? [{ phone: ACCT, name: '고성찬 이사', role: '회계' }] : [{ phone: ACCT, name: '고성찬 이사', role: '직원' }]),
    ],
    getVendors: async () => [{ name: 'Classic Fine Foods', aliases: ['CFF'], type: 'Food' }],
    getConfig: async () => ({ FILE_LABEL: '오름 {year} 매입 인보이스 모음', REF_PREPAID: '{name} 선지불, 추후 입금 해야함', REF_PAID: '{name} 대표 선지불, 추후 입금완료' }),
    listLedger: async () => Object.keys(tabs).flatMap(rowsOf),
    columnA: async (tab) => tabs[tab].map((r) => r[0]),
    insertLedgerRow: async (tab, values) => { tabs[tab].push([...values]); return tabs[tab].length; },
    updateLedgerRow: async (tab, rowNumber, vals) => { tabs[tab][rowNumber - 1] = [tabs[tab][rowNumber - 1][0], ...vals]; },
    updateRef: async (tab, rowNumber, ref) => { tabs[tab][rowNumber - 1][11] = ref; },
    updatePaid: async (tab, rowNumber, { paidDate, account, ref }) => { const r = tabs[tab][rowNumber - 1]; r[9] = paidDate; if (account) r[10] = account; r[11] = ref; },
    appendLog: async (o) => { log.push(o); },
  };
  const fx = { cnyToHkd: fxImpl || (async () => ({ rate: 1.10238, source: '네이버 매매기준율 테스트' })) };
  const calls = [];
  const extract = async (args) => { calls.push(args); return extractImpl(args, calls.length); };
  const bot = createBot({ wa, extract, sheets, fx, approvalTemplate: 'approval_ping', log: { warn() {}, error() {} } });
  let n = 0;
  const send = (m, from = STAFF) => bot.handle({ id: 'm' + (++n), from, name: 'wa-profile', type: 'text', ...m });
  const lastTo = (to, kind) => sent.filter((s) => s.to === to && (!kind || s.kind === kind)).at(-1);
  return { bot, sent, tabs, log, calls, send, lastTo, openWindow: () => { windowClosed = false; } };
}

const CFF = {
  readable: true, doc_type: 'invoice', date: '2026-10-20', vendor: 'CLASSIC FINE FOODS (HK) LTD', receipt_no: 'INV-208431', currency: 'HKD', total: 1075,
  items: [
    { name: 'Unsalted Butter 1kg', qty: '2', amount: 336, category: 'Food' },
    { name: 'Whipping Cream', qty: '3', amount: 255, category: 'Food' },
    { name: 'San Pellegrino', qty: '24', amount: 186, category: 'Drink' },
  ],
};
const IMG = { type: 'image', mediaId: 'media1', mimeType: 'image/jpeg' };

test('직원 영수증(선지불) → 회계 승인 → 장부 저장 → 입금완료 보고 → 회계 확인 → REF 갱신', async () => {
  const h = harness(() => CFF, { ledgerSeed: { Purchase_Food: [['#292', 'x', 'OLD-1', 20260921, 'Wah Kee', 'HKD', 'Food', 100, 100, '', '', '']] } });
  await h.send({ ...IMG, text: '선지불 급하게 샀어요' });

  const card = h.lastTo(ACCT, 'buttons');
  assert.match(card.body, /\[승인 요청\]/);
  assert.match(card.body, /올린 사람: 한상훈 매니져님/);
  assert.match(card.body, /시트: Purchase_Food/);
  assert.match(card.body, /한상훈 매니져님 선지불, 추후 입금 해야함/);
  assert.match(h.lastTo(STAFF).body, /회계 담당 승인 후 장부에 저장/);
  assert.equal(h.tabs.Purchase_Food.length, 2, '승인 전에는 저장하지 않음 (D06)');

  // 직원은 승인 못 함
  await h.send({ type: 'interactive', replyId: card.buttons[0].id });
  assert.match(h.lastTo(STAFF).body, /회계 담당만/);

  await h.send({ type: 'interactive', replyId: card.buttons[0].id }, ACCT);
  const row = h.tabs.Purchase_Food.at(-1);
  assert.equal(row[0], '#293', 'D07 기존 마지막 번호 다음');
  assert.equal(row[1], `오름 ${new Date().getFullYear()} 매입 인보이스 모음`);
  assert.deepEqual(row.slice(2, 9), ['INV-208431', 20261020, 'CLASSIC FINE FOODS (HK) LTD', 'HKD', 'Unsalted Butter 1kg x2, Whipping Cream x3, San Pellegrino x24', 1075, 1075]);
  assert.equal(row[11], '한상훈 매니져님 선지불, 추후 입금 해야함');
  assert.match(h.lastTo(STAFF).body, /회계 승인 완료 — Purchase_Food #293/);
  assert.equal(h.log.at(-1).상태, '저장');
  assert.equal(h.log.at(-1).승인자, '고성찬 이사');

  await h.send({ text: '#293 입금완료', timestamp: Date.UTC(2026, 9, 27, 17, 30) }); // 홍콩 10/28 01:30
  const pc = h.lastTo(ACCT, 'buttons');
  assert.match(pc.body, /입금완료 확인/);
  assert.equal(row[11], '한상훈 매니져님 선지불, 추후 입금 해야함', '회계 확인 전에는 그대로');
  await h.send({ type: 'interactive', replyId: pc.buttons[0].id }, ACCT);
  assert.equal(h.tabs.Purchase_Food.at(-1)[11], '한상훈 매니져님 대표 선지불, 추후 입금완료');
  assert.equal(h.tabs.Purchase_Food.at(-1)[9], 20261028, '지급일 = 입금완료 메시지의 홍콩 날짜');
  assert.match(pc.body, /지급일: 2026-10-28/);
  assert.match(h.lastTo(STAFF).body, /반영됐어요/);
});

test('번호 없는 경비 영수증 → Basic_ 번호, Expenses 연도 번호', async () => {
  const h = harness(() => ({ readable: true, doc_type: 'receipt', date: '2026-10-22', vendor: 'monolab', receipt_no: '', currency: 'HKD', total: 105, items: [{ name: 'Latte', qty: '3', amount: 105, category: 'Other' }] }),
    { ledgerSeed: { 'Expenses (SG&A)': [['#20260403']] } });
  await h.send({ ...IMG });
  const card = h.lastTo(ACCT, 'buttons');
  assert.match(card.body, /Basic_번호/);
  await h.send({ type: 'interactive', replyId: card.buttons[0].id }, ACCT);
  const year = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  const row = h.tabs['Expenses (SG&A)'].at(-1);
  const expected = year === 2026 ? '#20260404' : `#${year}0001`;
  assert.equal(row[0], expected);
  assert.equal(row[2], `Basic_${expected.slice(1)}`);
  assert.equal(row[11], '');
});

test('판독 불가 → 올린 사람에게 질문 → 답변 반영 → 승인 요청', async () => {
  const h = harness((args, n) => n === 1
    ? { readable: false, question: '총액이 흐려요. 얼마였나요?', items: [] }
    : { ...CFF, total: Number(args.answers[0].replace(/\D/g, '')) });
  await h.send({ ...IMG, mimeType: 'image/png' });
  assert.match(h.lastTo(STAFF).body, /총액이 흐려요/);
  assert.equal(h.lastTo(ACCT), undefined, '질문 단계에서는 회계에 보내지 않음');
  await h.send({ text: '1200' });
  assert.deepEqual(h.calls[1].answers, ['1200']);
  assert.match(h.lastTo(ACCT, 'buttons').body, /HKD 1,200.00/);
});

test('CNY: 네이버 환율 실패 → 승인 막힘 → 회계가 HKD 직접 입력 → 옛 카드 무효 → 새 카드로 저장', async () => {
  const h = harness(() => ({ readable: true, doc_type: 'receipt', date: '2026-06-07', vendor: 'Railway12306', receipt_no: 'E123', currency: 'CNY', total: 664.35, items: [{ name: 'HK-Guangzhou train', qty: '3', amount: 664.35, category: 'Other' }] }),
    { fxImpl: async () => { throw new Error('down'); } });
  await h.send({ ...IMG });
  const v1 = h.lastTo(ACCT, 'buttons');
  assert.match(v1.body, /네이버 환율 조회 실패/);
  await h.send({ type: 'interactive', replyId: v1.buttons[0].id }, ACCT);
  assert.match(h.lastTo(ACCT, 'text').body, /HKD 금액을 정할 수 없어요/);

  await h.send({ text: 'HKD 732.37' }, ACCT);
  const v2 = h.lastTo(ACCT, 'buttons');
  assert.match(v2.body, /\(수정 1\)/);
  assert.match(v2.body, /CNY 664.35 → HKD 732.37/);
  await h.send({ type: 'interactive', replyId: v1.buttons[0].id }, ACCT);
  assert.match(h.lastTo(ACCT).body, /새 카드/);
  await h.send({ type: 'interactive', replyId: v2.buttons[0].id }, ACCT);
  const row = h.tabs['Expenses (SG&A)'].at(-1);
  assert.deepEqual([row[5], row[7], row[8]], ['CNY', 664.35, 732.37]);
  assert.match(h.log.at(-1).AI대비수정, /HKD/);
});

test('CNY: 네이버 환율로 자동 환산', async () => {
  const h = harness(() => ({ readable: true, date: '2026-06-07', vendor: 'Railway12306', receipt_no: 'E1', currency: 'CNY', total: 664.35, items: [{ name: 't', amount: 664.35, category: 'Other' }] }));
  await h.send({ ...IMG });
  assert.match(h.lastTo(ACCT, 'buttons').body, /CNY 664.35 → HKD 732.37[\s\S]*네이버 매매기준율/);
});

test('D08 같은 증빙 재업로드 → 중복 표시 / D09 수정본 → 기존 행 수정', async () => {
  const seed = { Purchase_Food: [['#10', 'f', 'INV-208431', 20261020, 'Classic Fine Foods', 'HKD', 'old', 1075, 1075, '', '', 'R']] };
  const dup = harness(() => CFF, { ledgerSeed: seed });
  await dup.send({ ...IMG });
  const c = dup.lastTo(ACCT, 'buttons');
  assert.match(c.body, /이미 장부에 있는 증빙/);
  assert.equal(c.buttons[0].title, '그래도 저장');

  const rev = harness(() => ({ ...CFF, total: 990 }), { ledgerSeed: JSON.parse(JSON.stringify(seed)) });
  await rev.send({ ...IMG });
  const c2 = rev.lastTo(ACCT, 'buttons');
  assert.equal(c2.buttons[0].title, '기존 행 수정');
  await rev.send({ type: 'interactive', replyId: c2.buttons[0].id }, ACCT);
  assert.equal(rev.tabs.Purchase_Food.length, 2, '새 행을 만들지 않음');
  assert.equal(rev.tabs.Purchase_Food[1][0], '#10');
  assert.equal(rev.tabs.Purchase_Food[1][7], 990);
  assert.equal(rev.tabs.Purchase_Food[1][11], 'R', '기존 REF 유지');
  assert.equal(rev.log.at(-1).상태, '기존 행 수정');
});

test('D09 Credit Note → 원본 행 금액 차감', async () => {
  const seed = { Purchase_Food: [['#10', 'f', '401379001', 20260714, 'Classic Fine Foods', 'HKD', 'Butter x2', 1075, 1075, '', '', '']] };
  const h = harness(() => ({ readable: true, doc_type: 'credit_note', related_no: '401379001', date: '2026-07-16', vendor: 'Classic Fine Foods', receipt_no: 'CN-77', currency: 'HKD', total: 168, items: [{ name: 'Butter', qty: '1', amount: 168, category: 'Food' }] }),
    { ledgerSeed: seed });
  await h.send({ ...IMG });
  const c = h.lastTo(ACCT, 'buttons');
  assert.match(c.body, /Credit Note → 승인하면 원본 Purchase_Food #10/);
  await h.send({ type: 'interactive', replyId: c.buttons[0].id }, ACCT);
  const r = h.tabs.Purchase_Food[1];
  assert.deepEqual([r[0], r[7], r[8]], ['#10', 907, 907]);
  assert.match(r[6], /Credit Note CN-77 -168.00/);
});

test('분류 변경 목록 → 반려', async () => {
  const h = harness(() => CFF);
  await h.send({ ...IMG });
  const c = h.lastTo(ACCT, 'buttons');
  await h.send({ type: 'interactive', replyId: c.buttons[1].id }, ACCT);
  const list = h.lastTo(ACCT, 'list');
  await h.send({ type: 'interactive', replyId: list.rows.find((r) => r.title === 'Expenses (SG&A)').id }, ACCT);
  const c2 = h.lastTo(ACCT, 'buttons');
  assert.match(c2.body, /시트: Expenses \(SG&A\)/);
  await h.send({ type: 'interactive', replyId: c2.buttons[2].id }, ACCT);
  assert.match(h.lastTo(STAFF).body, /반려했어요/);
  assert.equal(h.tabs['Expenses (SG&A)'].length, 1);
  assert.equal(h.log.at(-1).상태, '반려');
});

test('24시간 창이 닫힌 승인자 → 템플릿 알림 → 승인자가 말을 걸면 대기 카드 전달', async () => {
  const h = harness(() => CFF, { failWindow: true });
  await h.send({ ...IMG });
  assert.equal(h.lastTo(ACCT).kind, 'template');
  assert.match(h.lastTo(STAFF).body, /회계 담당에게 바로 알리지 못했어요/);
  h.openWindow();
  await h.send({ text: '안녕' }, ACCT);
  assert.match(h.lastTo(ACCT, 'buttons').body, /\[승인 요청\]/);
});

test('승인자가 없으면 올린 사람이 직접 승인', async () => {
  const h = harness(() => CFF, { approvers: false });
  await h.send({ ...IMG });
  const c = h.lastTo(STAFF, 'buttons');
  assert.ok(c);
  await h.send({ type: 'interactive', replyId: c.buttons[0].id });
  assert.equal(h.tabs.Purchase_Food.at(-1)[0], '#1');
});

test('거래 증빙이 아님 → 확인 → "등록"이면 진행', async () => {
  const h = harness((args) => (args.answers.length ? CFF : { readable: true, doc_type: 'other', notes: 'CFF 가격표', items: [] }));
  await h.send({ ...IMG });
  assert.match(h.lastTo(STAFF).body, /거래 증빙.*아닌 것 같아요/);
  assert.equal(h.lastTo(ACCT), undefined);
  await h.send({ text: '등록' });
  assert.match(h.lastTo(ACCT, 'buttons').body, /\[승인 요청\]/);
});

test('송금 확인 화면 → 기존 장부 행 안내 → "번호 입금완료" 또는 "등록"', async () => {
  const seed = { 'Expenses (SG&A)': [['#20260368', 'f', '#20260824', 20260824, 'HK Electric', 'HKD', 'Electricity Bill', 23116, 23116, '', '', '']] };
  const h = harness((args) => (args.answers.length
    ? { readable: true, doc_type: 'receipt', date: '2026-08-29', vendor: 'HK Electric', currency: 'HKD', total: 23116, items: [{ name: '전기요금', category: 'Other', amount: 23116 }] }
    : { readable: true, doc_type: 'payment_slip', date: '2026-08-29', vendor: 'HONGKONG ELECTRIC', total: 23116, items: [] }), { ledgerSeed: seed });
  await h.send({ ...IMG });
  assert.match(h.lastTo(STAFF).body, /이미 같은 금액 건이 있어요: Expenses \(SG&A\) #20260368/);
  assert.equal(h.lastTo(ACCT), undefined);
  await h.send({ text: '등록' });
  const c = h.lastTo(ACCT, 'buttons');
  assert.match(c.body, /같은 날짜·금액 기록이 있어요|이미 장부에/, '등록해도 중복 경고가 붙음');
});

test('G01 법카 직원식사 → 경비, 구매 목적 표시·기록 / 번호 없는 Food는 PURF 번호', async () => {
  const h = harness((args) => (args.message.includes('staff meal')
    ? { readable: true, doc_type: 'receipt', date: '2026-07-09', vendor: 'McDonald’s Hong Kong', receipt_no: '', currency: 'HKD', total: 174, purpose: 'Staff meal', items: [{ name: 'Big Mac meal', qty: '4', amount: 174, category: 'Meal' }] }
    : { readable: true, doc_type: 'receipt', date: '2026-09-21', vendor: 'Market Place', receipt_no: '', currency: 'HKD', total: 311.5, items: [{ name: 'Parmigiano 200g', qty: '1', amount: 78, category: 'Food' }, { name: 'Gorgonzola 250g', qty: '1', amount: 83, category: 'Food' }, { name: 'Philadelphia cream cheese', qty: '5', amount: 149.5, category: 'Food' }, { name: '비닐봉투', qty: '1', amount: 1, category: 'Other' }] }),
  { ledgerSeed: { Purchase_Food: [['#292']] } });
  await h.send({ ...IMG, text: '9/7 - mcdonalds staff meal / 법카결제완료' });
  const c = h.lastTo(ACCT, 'buttons');
  assert.match(c.body, /시트: Expenses \(SG&A\)/);
  assert.match(c.body, /목적: Staff meal/);
  await h.send({ type: 'interactive', replyId: c.buttons[0].id }, ACCT);
  assert.equal(h.log.at(-1)['구매 목적'], 'Staff meal');

  await h.send({ ...IMG, mediaId: 'm2', text: '' });
  const c2 = h.lastTo(ACCT, 'buttons');
  assert.match(c2.body, /시트: Purchase_Food/);
  await h.send({ type: 'interactive', replyId: c2.buttons[0].id }, ACCT);
  const row = h.tabs.Purchase_Food.at(-1);
  const y = new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
  assert.deepEqual([row[0], row[2]], ['#293', `${y} PURF (293)`]);
});

test('G10 Statement → 이미 장부에 있는 인보이스면 새 매입으로 넣지 않음', async () => {
  const seed = { Purchase_Drink: [['#202', 'f', 'INV #HKSO2311039', 20260512, 'Prime Cellar HK', 'HKD', 'International Wine Sourcing', 2802, 2802, '', '', '']] };
  const h = harness(() => ({ readable: true, doc_type: 'statement', date: '2026-06-30', vendor: 'Prime Cellar (H.K.) Limited', related_no: 'HKSO2311039', total: 2802, items: [] }), { ledgerSeed: seed });
  await h.send({ ...IMG, mimeType: 'application/pdf' });
  assert.match(h.lastTo(STAFF).body, /statement의 인보이스는 이미 장부에 있어요: Purchase_Drink #202/);
  assert.equal(h.lastTo(ACCT), undefined);
  assert.equal(h.tabs.Purchase_Drink.length, 2);
});

test('월말 statement만 오는 거래처 → 장부에 없는 내용이면 일반 증빙처럼 1행 기장', async () => {
  const h = harness(() => ({ readable: true, doc_type: 'statement', date: '2026-07-31', vendor: 'Classic Fine Foods', receipt_no: 'O10220_Statement 31 JUL 2026', related_no: '', total: 2052, currency: 'HKD', items: [{ name: 'Food Ingredient', category: 'Food' }] }));
  await h.send({ ...IMG, mimeType: 'application/pdf' });
  const card = h.lastTo(ACCT, 'buttons');
  assert.ok(card, '회계 승인 카드가 감');
  await h.send({ type: 'interactive', replyId: card.buttons[0].id }, ACCT);
  const row = h.tabs.Purchase_Food.at(-1);
  assert.equal(row[2], 'O10220_Statement 31 JUL 2026');
  assert.equal(row[7], 2052);
});

test('등록 안 된 번호 무시, 중복 웹훅 무시, 지원 안 되는 파일 안내', async () => {
  const h = harness(() => CFF);
  await h.bot.handle({ id: 'z', from: '85299999999', name: '?', type: 'text', text: '도움말' });
  assert.equal(h.sent.length, 0);
  await h.send({ ...IMG });
  const count = h.sent.length;
  await h.bot.handle({ id: 'm1', from: STAFF, ...IMG });
  assert.equal(h.sent.length, count);
  await h.send({ type: 'document', mediaId: 'd', mimeType: 'application/vnd.ms-excel', text: '' });
  assert.match(h.lastTo(STAFF).body, /PDF/);
});

test('웹훅 파싱과 서명 검증', () => {
  const body = { entry: [{ changes: [{ value: {
    contacts: [{ wa_id: '852911', profile: { name: 'Mina' } }],
    messages: [
      { id: 'a', from: '852911', timestamp: '1', type: 'image', image: { id: 'IMG', mime_type: 'image/jpeg', caption: '선지불' } },
      { id: 'b', from: '852911', timestamp: '1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'ok:R1:1', title: '승인·저장' } } },
    ] } }] }] };
  const [a, b] = parseWebhook(body);
  assert.equal(a.mediaId, 'IMG'); assert.equal(a.text, '선지불'); assert.equal(a.name, 'Mina');
  assert.equal(b.replyId, 'ok:R1:1');
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.ok(verifySignature(raw, sig, 's3cret'));
  assert.ok(!verifySignature(raw, sig, 'wrong'));
});

test('발송 결과 131047(24시간 창 닫힘) → 승인자가 아무 말이나 하면 밀린 카드 전달', async () => {
  const h = harness(() => CFF);
  await h.send({ ...IMG });
  const before = h.sent.filter((s) => s.to === ACCT && s.kind === 'buttons').length;
  h.bot.handleStatus({ status: 'failed', recipient_id: ACCT, errors: [{ code: 131047 }] });
  await h.send({ text: '안녕' }, ACCT);
  assert.equal(h.sent.filter((s) => s.to === ACCT && s.kind === 'buttons').length, before + 1);
});

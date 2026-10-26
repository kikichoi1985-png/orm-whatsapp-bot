import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classify, toHKD, prepaidRef, paidRef, prepaidNameFromRef, isOpenPrepaidRef, findPrepaidRow, detailsText, nextNo,
  fallbackReceiptNo, findDuplicate, findPaidRow, ymdNumber, hkdOverride,
} from '../src/rules.js';
import { parseDailyQuote } from '../src/fx.js';

const V = [{ name: 'Classic Fine Foods', aliases: ['CFF'], type: 'Food' }];

test('D10 분류: 명확·불명확·혼합·동률·금액 누락', () => {
  assert.equal(classify([{ name: 'Butter', amount: 10, category: 'Food' }], 'x', V).category, 'Purchase_Food');
  assert.equal(classify([{ name: 'Wine', amount: 10, category: 'Drink' }], 'x', V).category, 'Purchase_Drink');
  assert.equal(classify([{ name: 'Taxi', amount: 10, category: 'Other' }], 'x', V).category, 'Expenses');
  // 불명확 → 거래처 유형 (별칭으로도 찾음)
  const u = classify([{ name: '??', category: 'Unclear' }], 'CFF', V);
  assert.equal(u.category, 'Purchase_Food'); assert.equal(u.needsReview, false);
  // 혼합 → 금액 큰 쪽
  const m = classify([{ name: 'a', amount: 300, category: 'Food' }, { name: 'b', amount: 500, category: 'Drink' }], 'x', V);
  assert.equal(m.category, 'Purchase_Drink'); assert.equal(m.needsReview, false);
  // 동률 → 확인
  assert.equal(classify([{ name: 'a', amount: 5, category: 'Food' }, { name: 'b', amount: 5, category: 'Other' }], 'x', V).needsReview, true);
  // 혼합인데 금액을 못 읽음 → 확인
  assert.equal(classify([{ name: 'a', category: 'Food' }, { name: 'b', amount: 5, category: 'Drink' }], 'x', V).needsReview, true);
  // 모두 불명확 + 모르는 거래처 → 확인
  assert.equal(classify([{ name: '?', category: 'Unclear' }], 'Unknown', V).category, '');
});

test('D12·D13 환산: 셋째 자리 반올림, CNY 외 통화는 환산 불가', () => {
  assert.deepEqual(toHKD(818.06, 'HKD '), { rate: 1, hkd: 818.06 });
  assert.equal(toHKD(664.35, 'CNY', 1.10238).hkd, 732.37);
  assert.equal(toHKD(100, 'USD', 7.8).hkd, null);
});

test('D11 REF 문구와 입금완료 대상 찾기', () => {
  assert.equal(prepaidRef('한상훈 매니져님'), '한상훈 매니져님 선지불, 추후 입금 해야함');
  assert.equal(paidRef('한상훈 매니져님'), '한상훈 매니져님 대표 선지불, 추후 입금완료');
  assert.equal(prepaidNameFromRef('한상훈 매니져님 선지불, 추후 입금 해야함'), '한상훈 매니져님');
  assert.ok(isOpenPrepaidRef('Mina 선지불, 추후 입금 해야함'));
  assert.ok(!isOpenPrepaidRef('최준우 대표 선지불, 추후 입금 완료'));
  const rows = [
    { no: '#20260401', receiptNo: 'Basic_20260401', ref: 'Mina 선지불, 추후 입금 해야함' },
    { no: '#20260402', receiptNo: 'INV-208431', ref: 'Mina 선지불, 추후 입금 해야함' },
    { no: '#20260403', receiptNo: 'X1', ref: '' },
  ];
  assert.equal(findPrepaidRow(rows, 'inv-208431 입금완료').hit.no, '#20260402');
  assert.equal(findPrepaidRow(rows, '#20260401 입금완료').hit.no, '#20260401');
  assert.equal(findPrepaidRow(rows, 'X1 입금완료').hit, null);
});

test('D07 매입관리번호: 시트별 형식, 양식 예시(Sample) 무시', () => {
  const exp = ['No.', null, '#1', '#20260402', '#20260403', 'Sample : 회계기간', 'No.', '#1', '#6'];
  assert.equal(nextNo('Expenses', exp, 2026), '#20260404');
  assert.equal(nextNo('Expenses', exp, 2027), '#20270001');
  assert.equal(nextNo('Purchase_Food', ['No.', '#290', '#292', '#291', 'Sample', '#6'], 2026), '#293');
  assert.equal(nextNo('Purchase_Drink', ['No.'], 2026), '#1');
  assert.equal(fallbackReceiptNo('#20260404'), 'Basic_20260404');
  assert.equal(fallbackReceiptNo('#20260404', 'Expenses', 2026), 'Basic_20260404');
  assert.equal(fallbackReceiptNo('#293', 'Purchase_Food', 2026), '2026 PURF (293)');
  assert.equal(fallbackReceiptNo('#56', 'Purchase_Drink', 2026), '2026 PURD (056)');
});

test('D08 중복 / D09 수정본 판정', () => {
  const rows = [
    { tab: 'Purchase_Food', no: '#5', receiptNo: '401379001', date: 20260714, vendor: 'Classic Fine Foods', amount: 1075 },
    { tab: 'Expenses (SG&A)', no: '#20260400', receiptNo: 'Basic_20260400', date: 20260918, vendor: 'monolab', amount: 105 },
  ];
  assert.equal(findDuplicate(rows, { vendor: 'CLASSIC FINE FOODS (HK) LTD', receiptNo: '#401379001', date: '2026-07-14', amount: 1075 }).kind, 'duplicate');
  assert.equal(findDuplicate(rows, { vendor: 'Classic Fine Foods', receiptNo: '401379001', date: '2026-07-15', amount: 990 }).kind, 'revision');
  assert.equal(findDuplicate(rows, { vendor: 'Monolab', receiptNo: '', date: '2026-09-18', amount: 105 }).kind, 'possible_duplicate');
  assert.equal(findDuplicate(rows, { vendor: 'Monolab', receiptNo: '', date: '2026-09-23', amount: 105 }).kind, 'possible_duplicate', '7일 이내');
  assert.equal(findDuplicate(rows, { vendor: 'Monolab', receiptNo: '', date: '2026-09-30', amount: 105 }), null);
  assert.equal(findDuplicate(rows, { vendor: 'Other shop', receiptNo: '', date: '2026-09-18', amount: 105 }), null);
});

test('실제 영수증방 사례: 식당·카페·바 식음료는 경비(Meal), 식재료 구매는 Purchase', () => {
  assert.equal(classify([{ name: 'Americano', amount: 42, category: 'Meal' }], 'Starbucks', V).category, 'Expenses');
  assert.equal(classify([{ name: 'Lunch', amount: 1529, category: 'Meal' }], 'Chueca', V).category, 'Expenses');
  assert.match(classify([{ name: 'Lunch', amount: 1, category: 'Meal' }], 'x', V).reason, /경비/);
  assert.equal(classify([{ name: 'Parmigiano 200g', amount: 78, category: 'Food' }, { name: 'Bag', amount: 1, category: 'Other' }], 'Market Place', V).category, 'Purchase_Food');
});

test('송금 확인·카드 문자 → 45일 이내 같은 금액 장부 행 찾기', () => {
  const rows = [{ tab: 'Expenses (SG&A)', no: '#20260368', date: 20260824, amount: 23116, hkd: 23116 }];
  assert.equal(findPaidRow(rows, { amount: 23116, date: '2026-08-29' }).no, '#20260368');
  assert.equal(findPaidRow(rows, { amount: 23116, date: '2026-11-29' }), null);
  assert.equal(findPaidRow(rows, { amount: 999, date: '2026-08-29' }), null);
});

test('상세내역·날짜 형식·HKD 직접 입력', () => {
  assert.equal(detailsText([{ name: 'Butter', qty: '2' }, { name: 'Cream' }]), 'Butter x2, Cream');
  assert.equal(ymdNumber('2026-10-20'), 20261020);
  assert.equal(hkdOverride('HKD 1,234.5 로 해줘'), 1234.5);
  assert.equal(hkdOverride('환산 732.37'), 732.37);
  assert.equal(hkdOverride('총액 1200'), null);
});

test('네이버 일별 시세 파싱', () => {
  const html = `<tr class="up"><td class="date">2026.10.22</td>
    <td class="num">193.21</td><td class="num"><img> 0.31</td></tr>
    <tr><td class="date">2026.10.21</td><td class="num">1,192.90</td></tr>`;
  assert.deepEqual(parseDailyQuote(html), [{ date: '2026-10-22', rate: 193.21 }, { date: '2026-10-21', rate: 1192.9 }]);
});

test('문서번호 비교: 장부 접두어 허용', async () => {
  const { sameDocNo } = await import('../src/rules.js');
  assert.ok(sameDocNo('INV #HKSO2311039', 'HKSO2311039'));
  assert.ok(sameDocNo('#401379001', '401379001'));
  assert.ok(!sameDocNo('#401379001', '401379002'));
  assert.ok(!sameDocNo('#12', '2'));
});

test('판독 응답 파싱: 도구 호출 / 본문 JSON', async () => {
  const { parseResult } = await import('../src/extract.js');
  assert.equal(parseResult({ content: [{ type: 'tool_use', name: 'record_receipt', input: { readable: true, items: [] } }] }).readable, true);
  assert.equal(parseResult({ content: [{ type: 'text', text: '결과: {"readable":false,"items":[]}' }] }).readable, false);
  assert.throws(() => parseResult({ content: [{ type: 'text', text: '모르겠어요' }] }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, toHKD, findPrepaidRow, isPrepaidText, isPaidText, detailsText, prepaidRef, paidRef } from '../src/rules.js';

const vendors = [{ name: 'Classic Fine Foods', type: 'Food' }, { name: 'Swire Coca-Cola HK', type: 'Drink' }];

test('규칙1: 품목이 모두 Food → Purchase_Food', () => {
  const r = classify([{ name: 'Butter', amount: 100, category: 'Food' }], 'Any', vendors);
  assert.equal(r.category, 'Purchase_Food');
});
test('규칙1: 식음료 외 품목 → Expenses', () => {
  assert.equal(classify([{ name: '장갑', amount: 50, category: 'Other' }], 'Taobao', vendors).category, 'Expenses');
});
test('규칙2: 품목 불명확 → 거래처 기준 (CFF=Food)', () => {
  const r = classify([{ name: '??', amount: 80, category: 'Unclear' }], 'CLASSIC FINE FOODS (HK) LTD', vendors);
  assert.equal(r.category, 'Purchase_Food');
  assert.match(r.reason, /규칙/);
});
test('규칙2: 품목·거래처 모두 불명 → 직접 선택', () => {
  const r = classify([{ name: '??', category: 'Unclear' }], 'Unknown Shop', vendors);
  assert.equal(r.category, ''); assert.equal(r.needsReview, true);
});
test('규칙3: 혼합이면 금액 큰 쪽', () => {
  const items = [
    { name: 'Butter', amount: 336, category: 'Food' }, { name: 'Cream', amount: 255, category: 'Food' },
    { name: 'San Pellegrino', amount: 186, category: 'Drink' }, { name: 'Wine', amount: 500, category: 'Drink' },
  ];
  assert.equal(classify(items, 'X', vendors).category, 'Purchase_Drink'); // Drink 686 > Food 591
});
test('규칙3: 동률은 확인 필요', () => {
  const r = classify([{ name: 'a', amount: 10, category: 'Food' }, { name: 'b', amount: 10, category: 'Drink' }], 'X', vendors);
  assert.equal(r.needsReview, true);
});
test('B03: CNY 환산 반올림', () => {
  assert.deepEqual(toHKD(276.6, 'CNY', 1.09), { rate: 1.09, hkd: 301.49 });
  assert.deepEqual(toHKD(1075, 'HKD', 1.09), { rate: 1, hkd: 1075 });
  assert.deepEqual(toHKD(10, 'USD', 1.09), { rate: null, hkd: null });
});
test('B01: 선지불/입금완료 인식', () => {
  assert.ok(isPrepaidText('선지불 — 급하게 샀어요')); assert.ok(isPrepaidText('선 지불'));
  assert.ok(isPaidText('INV-208431 입금 완료')); assert.ok(!isPaidText('입금 예정'));
  assert.equal(prepaidRef('Mina'), 'Mina 선지불, 추후 입금 해야함');
  assert.equal(paidRef('Mina'), 'Mina 선지불, 추후 입금완료');
});
test('입금완료: 영수증번호/ID로 미입금 선지불 행 찾기', () => {
  const rows = [
    { id: 'R261020-AAA', receiptNo: 'INV-208431', ref: 'Mina 선지불, 추후 입금 해야함' },
    { id: 'R261021-BBB', receiptNo: '', ref: 'Jun 선지불, 추후 입금 해야함' },
    { id: 'R261021-CCC', receiptNo: 'X1', ref: '' },
  ];
  assert.equal(findPrepaidRow(rows, 'inv-208431 입금완료').hit.id, 'R261020-AAA');
  assert.equal(findPrepaidRow(rows, '#R261021-BBB 입금완료했어요').hit.id, 'R261021-BBB');
  const miss = findPrepaidRow(rows, '입금완료');
  assert.equal(miss.hit, null); assert.equal(miss.open.length, 2);
});
test('상세내역은 품목과 수량만', () => {
  assert.equal(detailsText([{ name: 'Butter', qty: '2' }, { name: 'Cream' }]), 'Butter x2, Cream');
});

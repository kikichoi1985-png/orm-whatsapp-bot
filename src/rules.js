// 현업 규칙 (시트 '05_현업 요구사항 원문' B01~B03 현업 추가 답변 기준). 외부 의존성 없는 순수 함수.

export const CATEGORIES = {
  Purchase_Food: 'Purchase_Food',
  Purchase_Drink: 'Purchase_Drink',
  Expenses: 'Expenses (SG&A)',
};
const ITEM_TO_CAT = { Food: 'Purchase_Food', Drink: 'Purchase_Drink', Other: 'Expenses' };

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 거래처 기준정보에서 주 취급 품목(Food|Drink|Mixed|Other)을 찾는다. 대소문자·부분일치 허용. */
export function vendorType(vendor, vendors = []) {
  if (!vendor) return null;
  const n = String(vendor).trim().toLowerCase();
  const exact = vendors.find((v) => v.name.toLowerCase() === n);
  if (exact) return exact.type;
  const partial = vendors.find((v) => {
    const vn = v.name.toLowerCase();
    return vn.length >= 3 && (n.includes(vn) || vn.includes(n));
  });
  return partial ? partial.type : null;
}

/**
 * B02 매입 분류
 *  1) 품목이 명확하면 Drink→Purchase_Drink, Food→Purchase_Food, 그 외→Expenses
 *  2) 품목이 불명확하면 거래처의 Food/Drink 취급 구분을 따른다
 *  3) 카테고리가 섞이면 결제금액이 큰 카테고리
 * @returns {{category: string, reason: string, needsReview: boolean}}
 */
export function classify(items = [], vendor, vendors = []) {
  const vt = vendorType(vendor, vendors);
  const sums = { Food: 0, Drink: 0, Other: 0 };
  let unclear = 0;
  let anyAmount = false;
  for (const it of items) {
    let c = ['Food', 'Drink', 'Other'].includes(it.category) ? it.category : null;
    const amt = Number(it.amount);
    let w = 1;
    if (Number.isFinite(amt) && amt > 0) { w = amt; anyAmount = true; }
    if (!c) {
      unclear++;
      if (['Food', 'Drink', 'Other'].includes(vt)) c = vt; else continue;
    }
    sums[c] += w;
  }
  const present = Object.entries(sums).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

  if (!present.length) {
    if (vt === 'Food' || vt === 'Drink') {
      return { category: ITEM_TO_CAT[vt], reason: `품목이 불분명해 거래처 기준(${vt} 거래처)으로 분류 [규칙2]`, needsReview: false };
    }
    return { category: '', reason: '품목이 불분명하고 거래처 기준정보도 없음 — 직접 선택 필요', needsReview: true };
  }
  const [top] = present[0];
  if (present.length === 1) {
    const reason = unclear
      ? `명확한 품목은 모두 ${top}, 불분명한 품목 ${unclear}개는 거래처 기준(${vt}) 적용 [규칙1·2]`
      : `품목이 모두 ${top === 'Other' ? '식음료 외 품목' : top} [규칙1]`;
    return { category: ITEM_TO_CAT[top], reason, needsReview: false };
  }
  // 동률이면 사람이 확인
  const tie = present[1][1] === present[0][1];
  const parts = present.map(([k, v]) => `${k} ${anyAmount ? round2(v) : v + '개'}`).join(' / ');
  return {
    category: ITEM_TO_CAT[top],
    reason: `카테고리 혼합 → ${anyAmount ? '결제금액' : '품목 수'}이 큰 쪽: ${parts} [규칙3]${tie ? ' (동률 — 확인 필요)' : ''}`,
    needsReview: tie,
  };
}

/** B03 HKD 환산. 통화가 HKD면 그대로, CNY면 설정 환율, 그 외는 환산 불가(null). 소수 둘째 자리 반올림. */
export function toHKD(amount, currency, cnyRate) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return { rate: null, hkd: null };
  const cur = String(currency || '').toUpperCase();
  if (cur === 'HKD') return { rate: 1, hkd: round2(a) };
  if (cur === 'CNY' && cnyRate > 0) return { rate: cnyRate, hkd: round2(a * cnyRate) };
  return { rate: null, hkd: null };
}

/** B01 선지불 표시 — 작성자가 '선지불'이라고 쓰는 규칙 */
export const isPrepaidText = (text) => /선\s*지불/.test(text || '');
/** 입금 완료 보고 — "영수증번호 입금완료" */
export const isPaidText = (text) => /입금\s*완료/.test(text || '');

export const prepaidRef = (name) => `${name || '?'} 선지불, 추후 입금 해야함`;
export const paidRef = (name) => `${name || '?'} 선지불, 추후 입금완료`;

/** 입금완료 메시지에서 영수증 번호 후보 토큰을 뽑는다. */
export function paidTokens(text) {
  return (String(text || '').match(/#?[A-Za-z0-9][A-Za-z0-9\-\/]{2,}/g) || [])
    .map((t) => normalizeNo(t.replace(/^#/, '')));
}
export const normalizeNo = (s) => String(s || '').toUpperCase().replace(/[\s#]/g, '');

/** 미입금 선지불 행 중 토큰과 맞는 행을 찾는다. rows: {id, receiptNo, ref} */
export function findPrepaidRow(rows, text) {
  const tokens = paidTokens(text);
  const open = rows.filter((r) => /선지불/.test(r.ref || '') && !/입금완료/.test(r.ref || ''));
  const hit = open.find((r) => tokens.some((t) => t === normalizeNo(r.id) || (r.receiptNo && t === normalizeNo(r.receiptNo))));
  return { hit: hit || null, open };
}

/** 상세내역: 품목과 개수만 (B01 현업 답변) */
export const detailsText = (items = []) =>
  items.map((i) => `${i.name || '?'}${i.qty !== undefined && i.qty !== null && i.qty !== '' ? ' x' + i.qty : ''}`).join(', ');

export const fmtMoney = (n) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n))
    ? '-'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

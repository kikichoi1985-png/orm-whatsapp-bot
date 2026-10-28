// 현업 규칙 — PoC 시트 '03_결정사항 입력'(D06~D15, D29)과 '09_장부 필드 정의' 기준. 외부 의존성 없는 순수 함수.

/** 장부 탭 (실제 오름 통합 회계 시트의 탭 이름과 동일) */
export const CATEGORIES = {
  Purchase_Food: 'Purchase_Food',
  Purchase_Drink: 'Purchase_Drink',
  Expenses: 'Expenses (SG&A)',
};
/** 현금 인출(패티캐쉬) 기록 탭 — 실제 회계 시트 'Patty Cash Record'와 같은 이름·열 */
export const PATTY_TAB = 'Patty Cash Record';
export const PATTY_HEADERS = ['No.', '날짜 (Date)', '캐쉬아웃 기록 (Transfer To/From)', '캐쉬아웃 (Withdrawal)', '캐쉬인 (Deposit)', '리마크 (Remark)'];
export const PATTY_DEFAULT_DESC = 'Cash Withdrawal for patty cash';
/** '리마크 …' 답장에서 리마크 문구만 꺼냄 */
export const remarkFromText = (t) => { const m = String(t || '').match(/^\s*(?:리마크|remark|비고|메모)\s*[:：]?\s*(.+)$/is); return m ? m[1].trim() : null; };
const ITEM_TO_CAT = { Food: 'Purchase_Food', Drink: 'Purchase_Drink', Other: 'Expenses' };

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 거래처 기준정보에서 취급 특성(Food|Drink|Mixed|Other)을 찾는다. 대소문자·부분일치·별칭 허용. */
export function vendorType(vendor, vendors = []) {
  if (!vendor) return null;
  const n = String(vendor).trim().toLowerCase();
  const names = (v) => [v.name, ...(v.aliases || [])].map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const exact = vendors.find((v) => names(v).includes(n));
  if (exact) return exact.type;
  const partial = vendors.find((v) => names(v).some((vn) => vn.length >= 3 && (n.includes(vn) || vn.includes(n))));
  return partial ? partial.type : null;
}

/**
 * D10 매입 분류
 *  1) 품목이 명확하면 Drink→Purchase_Drink, Food→Purchase_Food, 그 외→Expenses (SG&A)
 *  2) 품목이 불명확하면 거래처 유형(CFF=Food)
 *  3) 카테고리가 섞이면 결제금액이 큰 카테고리
 *  카테고리별 금액이 같거나 금액을 확인할 수 없으면 담당자에게 문의(needsReview)
 * @returns {{category: string, reason: string, needsReview: boolean}}
 */
export function classify(items = [], vendor, vendors = []) {
  const vt = vendorType(vendor, vendors);
  const sums = { Food: 0, Drink: 0, Other: 0 };
  const counts = { Food: 0, Drink: 0, Other: 0 };
  let unclear = 0;
  let missingAmount = false;
  let meals = 0;
  for (const it of items) {
    // Meal(식당·카페·바에서 사 먹은 것)은 식재료 구매가 아니므로 경비 — 실제 장부 관행(회식·회의 식대 → Expenses)
    if (it.category === 'Meal') meals++;
    let c = it.category === 'Meal' ? 'Other' : ['Food', 'Drink', 'Other'].includes(it.category) ? it.category : null;
    if (!c) {
      unclear++;
      if (['Food', 'Drink', 'Other'].includes(vt)) c = vt; else continue;
    }
    const amt = Number(it.amount);
    // 할인 줄(음수)은 그 카테고리 금액에서 빼고, 0원(증정품)은 그대로 둔다. 금액이 아예 없을 때만 '못 읽음'
    if (it.amount !== undefined && it.amount !== null && it.amount !== '' && Number.isFinite(amt)) sums[c] += amt; else missingAmount = true;
    counts[c]++;
  }
  const present = Object.keys(counts).filter((k) => counts[k] > 0);

  if (!present.length) {
    if (vt === 'Food' || vt === 'Drink') {
      return { category: ITEM_TO_CAT[vt], reason: `품목이 불분명해 거래처 유형(${vt})으로 분류 [D10-2]`, needsReview: false };
    }
    return { category: '', reason: '품목이 불분명하고 거래처 기준정보도 없음 — 담당자 확인 필요', needsReview: true };
  }
  if (present.length === 1) {
    const top = present[0];
    const reason = unclear
      ? `명확한 품목은 모두 ${top}, 불분명한 품목 ${unclear}개는 거래처 유형(${vt}) 적용 [D10-1·2]`
      : meals ? '식당·카페·바에서 사 먹은 식음료(식대·회식·회의) → 경비 [D10-1]'
      : `품목이 모두 ${top === 'Other' ? '식음료 외' : top} [D10-1]`;
    return { category: ITEM_TO_CAT[top], reason, needsReview: false };
  }
  // 혼합: 결제금액이 큰 쪽. 금액을 모르거나 동률이면 문의
  const ranked = present.sort((a, b) => sums[b] - sums[a]);
  const parts = ranked.map((k) => `${k} ${round2(sums[k])}`).join(' / ');
  if (missingAmount) {
    return { category: ITEM_TO_CAT[ranked[0]], reason: `카테고리 혼합인데 품목별 금액을 다 읽지 못함 (${parts}) — 확인 필요 [D10-3]`, needsReview: true };
  }
  const tie = sums[ranked[0]] === sums[ranked[1]];
  return {
    category: ITEM_TO_CAT[ranked[0]],
    reason: `카테고리 혼합 → 결제금액이 큰 쪽: ${parts} [D10-3]${tie ? ' (동률 — 확인 필요)' : ''}`,
    needsReview: tie,
  };
}

/** D12·D13 HKD 환산. HKD는 그대로, CNY는 영수증일 환율, 그 외 통화는 환산 불가(null). 소수 셋째 자리에서 반올림. */
export function toHKD(amount, currency, cnyRate) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return { rate: null, hkd: null };
  const cur = String(currency || '').trim().toUpperCase();
  if (cur === 'HKD') return { rate: 1, hkd: round2(a) };
  if (cur === 'CNY' && cnyRate > 0) return { rate: cnyRate, hkd: round2(a * cnyRate) };
  return { rate: null, hkd: null };
}

/** D11 선지불 — 작성자가 '선지불'이라고 쓰는 규칙 */
export const isPrepaidText = (text) => /선\s*지[불급]/.test(text || '');
/** 입금 완료 보고 — "영수증번호 입금완료" */
export const isPaidText = (text) => /입금\s*완료/.test(text || '');

export const DEFAULT_REF = {
  prepaid: '{name} 선지불, 추후 입금 해야함',
  paid: '{name} 대표 선지불, 추후 입금완료',
};
const fill = (tpl, name) => String(tpl).replace(/\{name\}/g, name || '?');
export const prepaidRef = (name, tpl = DEFAULT_REF.prepaid) => fill(tpl, name);
export const paidRef = (name, tpl = DEFAULT_REF.paid) => fill(tpl, name);
export const isOpenPrepaidRef = (ref) => /선지[불급]/.test(ref || '') && /입금\s*해야/.test(ref || '');
/** 열린 선지불 REF에서 원 작성자 이름을 꺼낸다 */
export const prepaidNameFromRef = (ref) => String(ref || '').split(/\s*선지[불급]/)[0].trim();

export const normalizeNo = (s) => String(s || '').toUpperCase().replace(/[\s#]/g, '');
/** 장부 표기("INV #HKSO2311039", "Wah Kee #ORM-july")와 문서번호("HKSO2311039")를 같은 번호로 본다 */
export function sameDocNo(ledgerNo, docNo) {
  const a = normalizeNo(ledgerNo); const b = normalizeNo(docNo);
  if (!a || !b) return false;
  return a === b || (b.length >= 5 && a.endsWith(b)) || (a.length >= 5 && b.endsWith(a));
}
const normalizeVendor = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\b(limited|ltd|co|company|hk|hong kong)\b/g, '').replace(/[^a-z0-9가-힣]/g, '');

/** 입금완료 메시지에서 영수증 번호 후보 토큰을 뽑는다. */
export function paidTokens(text) {
  return (String(text || '').match(/#?[A-Za-z0-9][A-Za-z0-9\-\/_]{2,}/g) || []).map((t) => normalizeNo(t));
}

/** 미입금 선지불 행 중 토큰(매입관리번호 또는 영수증번호)과 맞는 행. rows: listLedger() 결과 */
export function findPrepaidRow(rows, text) {
  const tokens = paidTokens(text);
  const open = rows.filter((r) => isOpenPrepaidRef(r.ref));
  const hit = open.find((r) => tokens.some((t) => t === normalizeNo(r.no) || (r.receiptNo && t === normalizeNo(r.receiptNo))));
  return { hit: hit || null, open };
}

/** D15 상세내역: 품목과 개수만 */
export const detailsText = (items = []) =>
  items.map((i) => `${i.name || '?'}${i.qty !== undefined && i.qty !== null && i.qty !== '' ? ' x' + i.qty : ''}`).join(', ');

/** 'YYYY-MM-DD' → 20261020 (장부 D열 형식) */
export function ymdNumber(date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Number(m[1] + m[2] + m[3]) : '';
}

/**
 * D07 매입관리번호 — 기존 마지막 번호를 확인하고 승인 저장 시 확정
 *  - Expenses (SG&A): #YYYY + 4자리 일련번호 (예: #20260404). 해당 연도 번호가 없으면 0001부터
 *  - Purchase_Food / Purchase_Drink: #N 일련번호
 * existing: 그 탭 A열 값 목록. 'Sample' 이후(양식 예시)는 무시.
 */
export function nextNo(category, existing = [], year) {
  const vals = [];
  for (const v of existing) {
    const s = String(v ?? '').trim();
    if (/^sample/i.test(s)) break;
    vals.push(s);
  }
  if (category === 'Expenses') {
    const prefix = String(year);
    const seqs = vals.map((s) => s.match(/^#(\d{4})(\d{4})$/)).filter((m) => m && m[1] === prefix).map((m) => Number(m[2]));
    const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
    return `#${prefix}${String(next).padStart(4, '0')}`;
  }
  const nums = vals.map((s) => s.match(/^#(\d{1,6})$/)).filter(Boolean).map((m) => Number(m[1]));
  return `#${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

/**
 * 공식 번호가 없는 증빙의 내부 영수증번호 (실제 장부 관행, '자료 - 현황' 4단계 EXP·PURF·PURD 계열)
 *  Expenses: Basic_20260404 / Purchase_Food: 2026 PURF (293) / Purchase_Drink: 2026 PURD (206)
 */
export function fallbackReceiptNo(no, category = 'Expenses', year) {
  const n = String(no).replace(/^#/, '');
  if (category === 'Purchase_Food') return `${year} PURF (${n.padStart(3, '0')})`;
  if (category === 'Purchase_Drink') return `${year} PURD (${n.padStart(3, '0')})`;
  return `Basic_${n}`;
}

/**
 * D08 중복 판정 / D09 수정본
 *  - 업체+문서번호가 같으면: 금액·날짜도 같으면 'duplicate', 다르면 'revision'(기존 행 수정 대상)
 *  - 문서번호가 없으면 날짜+금액(+업체)이 같은 행을 'possible_duplicate'로
 * rows: listLedger() 결과, cand: {vendor, receiptNo, date(YYYY-MM-DD), amount}
 */
export function findDuplicate(rows, cand) {
  const no = normalizeNo(cand.receiptNo);
  const ven = normalizeVendor(cand.vendor);
  const date = ymdNumber(cand.date);
  const amt = round2(cand.amount);
  const sameVendor = (r) => !ven || !normalizeVendor(r.vendor) || normalizeVendor(r.vendor) === ven
    || normalizeVendor(r.vendor).includes(ven) || ven.includes(normalizeVendor(r.vendor));
  if (no && !/^BASIC/.test(no)) {
    const hit = rows.find((r) => sameDocNo(r.receiptNo, no) && sameVendor(r));
    if (hit) {
      const same = round2(hit.amount) === amt && (!date || Number(hit.date) === date);
      return { kind: same ? 'duplicate' : 'revision', row: hit };
    }
    // 번호가 달라도 같은 업체·같은 날짜·같은 금액이면 의심 (기존 행이 내부 번호로 저장된 경우 등)
    const twin = rows.find((r) => round2(r.amount) === amt && sameVendor(r) && date && Number(r.date) === date);
    return twin ? { kind: 'possible_duplicate', row: twin } : null;
  }
  const hit = rows.find((r) => round2(r.amount) === amt && sameVendor(r) && withinDays(r.date, date, 7));
  return hit ? { kind: 'possible_duplicate', row: hit } : null;
}

/** ymd 숫자 두 개가 n일 이내인지 (한쪽을 모르면 false) */
function withinDays(a, b, n) {
  const toD = (x) => { const s = String(x); return /^\d{8}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : null; };
  const da = toD(a); const db = toD(b);
  return da != null && db != null && Math.abs(da - db) <= n * 864e5;
}

/** 송금 확인·카드 결제 문자: 같은 금액의 기존 장부 행(45일 이내)을 찾는다 → 새 행 대신 지급 증빙으로 연결 */
export function findPaidRow(rows, { amount, date }) {
  const amt = round2(amount);
  const d = ymdNumber(date);
  return rows.filter((r) => round2(r.hkd) === amt || round2(r.amount) === amt).find((r) => !d || withinDays(r.date, d, 45)) || null;
}

/** 정정 메시지에서 직접 지정한 HKD 금액 ("HKD 123.45", "환산 123.45") */
export function hkdOverride(text) {
  const m = String(text || '').match(/(?:HKD|환산)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
  return m ? round2(m[1].replace(/,/g, '')) : null;
}

export const fmtMoney = (n) =>
  n === null || n === undefined || n === '' || Number.isNaN(Number(n))
    ? '-'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 홍콩 기준 현재 연도·시각 */
export const hkNow = () => new Date(Date.now() + 8 * 3600 * 1000);
export const hkYear = () => hkNow().getUTCFullYear();
/** 시각(ms) → 홍콩 날짜 YYYYMMDD 숫자 (장부 날짜 형식) */
export const hkDateNumber = (ms) => Number(new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, ''));
export const fmtYmd = (n) => String(n).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
export const hkStamp = () => hkNow().toISOString().slice(0, 16).replace('T', ' ');

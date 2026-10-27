// 대화 흐름 — 영수증 접수 → AI 판독 → (필요 시 올린 사람에게 질문) → 회계 담당 승인 → 장부 저장
// D06 모든 입력은 회계 담당 승인 후 저장 / D07 승인 저장 시 번호 확정 / D08 중복 / D09 수정본·Credit Note는 기존 행 수정
// D10 분류 / D11 선지불 REF / D12·D13 CNY 환산 / D15 상세내역·판독 불가 질문 / D23 담당자 알림
import {
  CATEGORIES, classify, toHKD, isPrepaidText, isPaidText, prepaidRef, paidRef, prepaidNameFromRef, findPrepaidRow,
  detailsText, fmtMoney, round2, ymdNumber, nextNo, fallbackReceiptNo, findDuplicate, findPaidRow, normalizeNo, sameDocNo, hkdOverride,
  hkYear, hkStamp, hkDateNumber, fmtYmd, DEFAULT_REF, PATTY_TAB, PATTY_DEFAULT_DESC, remarkFromText,
} from './rules.js';
import { SUPPORTED_MIME } from './extract.js';

/** 홍콩 기준 오늘 ± n일 → YYYY-MM-DD */
const ymdOffset = (n) => new Date(Date.now() + 8 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
/** '취소' 판단: 띄어쓰기·문장부호·흔한 오타 허용 (취쇼, 취소요, 취소해 줘, cancel, 그만) */
export const isCancelText = (t) => { const n = String(t || '').replace(/[\s.!?~ㅠㅜ]/g, '').toLowerCase(); return n.length <= 7 && /^(취[소쇼]|츼소|취서|cancel|그만)/.test(n); };
const UNSUPPORTED_TEXT = '사진, PDF, 글자 메시지만 처리할 수 있어요. 음성 메시지는 아직 지원하지 않아요.';
const TTL = { asking: 3 * 864e5, notdoc: 3 * 864e5, pending: 14 * 864e5 };
const CAT_WORDS = [
  [/food|식재료|푸드|식품/i, 'Purchase_Food'],
  [/drink|음료|주류|드링크/i, 'Purchase_Drink'],
  [/expense|sg&a|경비|비용|기타/i, 'Expenses'],
];

const HELP_STAFF = [
  "O'rm 영수증 비서 사용법",
  '1) 영수증·인보이스 사진이나 PDF를 보내 주세요. 개인 돈으로 냈으면 캡션에 "선지불"이라고 적어 주세요.',
  '2) 비서가 읽은 내용을 회계 담당에게 보내고, 승인되면 장부에 저장돼요. 틀린 곳은 답장으로 알려 주세요 (예: "총액 1,200", "날짜 10/20").',
  '3) 선지불 건을 입금받았으면 "번호 입금완료"라고 보내 주세요 (예: "#20260404 입금완료" 또는 "INV-208431 입금완료").',
].join('\n');
const HELP_APPROVER = [
  '회계 담당 사용법',
  '- 승인 요청 카드에서 [승인·저장] / [분류 변경] / [반려]를 누르세요.',
  '- 카드 내용을 고치려면 답장으로 보내세요 (예: "분류 Drink", "총액 1200", "HKD 732.37", "날짜 2026-10-20").',
  '- "대기"라고 보내면 승인 대기 중인 건을 다시 보여 줘요.',
].join('\n');

export function createBot({
  wa, extract, sheets, fx = null, allowed = [], approvers = [], approvalTemplate = '', templateLang = 'ko',
  log = console, persistDelayMs = 1500, batchMs = 0,
}) {
  const drafts = new Map();     // id -> draft
  const latest = new Map();     // 올린 사람 phone -> 최근 draftId
  const focus = new Map();      // 승인자 phone -> 마지막으로 본 draftId
  const paidReqs = new Map();   // id -> 입금완료 확인 요청
  const media = new Map();      // draftId -> {base64, mimeType} (메모리만)
  const seen = new Map();
  const queues = new Map();
  const prepaidHint = new Map();
  const needsNotify = new Set(); // 24시간 창이 닫혀 카드를 못 받은 승인자

  // ---------- 사람·설정 ----------
  async function people() {
    let staff = [];
    try { staff = await sheets.getStaff(); } catch (e) { log.warn?.('Staff 탭 읽기 실패', e.message); }
    const sheetApprovers = staff.filter((s) => /회계|account/i.test(s.role)).map((s) => s.phone);
    const apprs = sheetApprovers.length ? sheetApprovers : approvers;
    const allow = new Set([...staff.map((s) => s.phone), ...allowed, ...apprs]);
    return { staff, approvers: apprs, allowAll: allow.size === 0, allow };
  }
  async function config() { try { return await sheets.getConfig(); } catch { return {}; } }
  async function vendors() { try { return await sheets.getVendors(); } catch (e) { log.warn?.('vendors', e.message); return []; } }

  let seq = 0;
  const newId = (p = 'R') => {
    const d = new Date(Date.now() + 8 * 3600e3);
    return `${p}${d.toISOString().slice(2, 10).replace(/-/g, '')}-${(Date.now() % 46656).toString(36).toUpperCase().padStart(3, '0')}${(seq++ % 36).toString(36).toUpperCase()}`;
  };

  // ---------- 보관 (서버 재시작 대비) ----------
  let persistTimer = null;
  function persist() {
    if (!sheets.savePending) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const list = [...drafts.values()].map((d) => ({ ...d, kind: 'draft' })).concat([...paidReqs.values()].map((p) => ({ ...p, kind: 'paid' })));
      sheets.savePending(list).catch((e) => log.warn?.('대기 건 보관 실패', e.message));
    }, persistDelayMs);
  }
  async function restore() {
    if (!sheets.loadPending) return 0;
    const list = await sheets.loadPending();
    for (const x of list) {
      if (x.kind === 'paid') paidReqs.set(x.id, x);
      else { drafts.set(x.id, x); latest.set(x.phone, x.id); }
    }
    return list.length;
  }
  function gc() {
    const now = Date.now();
    for (const [id, d] of drafts) if (now - d.createdAt > (TTL[d.state] || TTL.pending)) { drafts.delete(id); media.delete(id); }
    for (const [id, t] of seen) if (now - t > 864e5) seen.delete(id);
  }

  // ---------- 판독 ----------
  /** 첨부 내려받기. 연달아 보낸 사진 묶음이면 배열로 돌려준다 */
  async function getMedia(d) {
    if (!media.has(d.id)) {
      const ids = d.mediaIds?.length ? d.mediaIds : [d.mediaId];
      const files = await Promise.all(ids.map((id) => wa.downloadMedia(id)));
      media.set(d.id, files.length === 1 ? files[0] : files);
    }
    return media.get(d.id);
  }

  async function rateFor(d, cfg) {
    if (d.currency === 'HKD') return { rate: 1, source: '' };
    if (d.currency !== 'CNY') return { rate: null, source: `${d.currency} 환산 기준이 없음 (D12·D13은 CNY만 정의)` };
    if (fx) {
      try { const r = await fx.cnyToHkd(d.date); return { rate: r.rate, source: r.source }; } catch (e) { log.warn?.('환율 조회 실패', e.message); }
    }
    const fb = Number(cfg.CNY_HKD_FALLBACK);
    if (fb > 0) return { rate: fb, source: `네이버 환율 조회 실패 → 임시 환율 ${fb} (Config) — 확인 필요`, warn: true };
    return { rate: null, source: '네이버 환율 조회 실패 — HKD 금액 확인 필요', warn: true };
  }

  async function runExtraction(d, given = null) {
    const [vs, cfg] = await Promise.all([vendors(), config()]);
    let out = given || await extract({ media: await getMedia(d), sender: d.name, message: d.message, answers: d.answers, vendors: vs, part: d.part || null });
    // 한 사진에 영수증 여러 장 → 1장 1행: 첫 장은 이 접수로, 나머지는 startDraft에서 따로 접수
    const many = !given && !d.part && Array.isArray(out.receipts) && out.receipts.length > 1;
    if (many) {
      const all = out.receipts.map((r) => ({ readable: true, doc_type: out.doc_type, ...r }));
      d.split = all.slice(1);
      d.part = { index: 1, total: all.length, receiptNo: all[0].receipt_no || '', amount: all[0].total };
      out = all[0];
    }
    if (out && out.receipts) { const { receipts, ...rest } = out; out = rest; }
    d.ai = out;
    d.docType = d.forceReceipt ? 'receipt' : (out.doc_type || 'receipt');
    if (out.readable === false) { d.state = 'asking'; return; }
    if (['other', 'statement', 'payment_slip'].includes(d.docType)) {
      d.state = 'notdoc';
      d.slip = { amount: Number(out.total) || 0, date: out.date || '', vendor: out.vendor || '' };
      if (['payment_slip', 'statement'].includes(d.docType)) {
        try {
          const rows = await sheets.listLedger();
          const nos = String(out.related_no || '').split(/[,\s]+/).map(normalizeNo).filter(Boolean);
          // 장부 영수증번호에 "INV #" 같은 접두어가 붙어 있어도 찾도록 포함 비교
          const hasNo = (r) => { const rn = normalizeNo(r.receiptNo); return nos.some((n) => n.length >= 5 && rn.includes(n)); };
          d.slipRow = (nos.length && rows.find(hasNo)) || (d.slip.amount ? findPaidRow(rows, d.slip) : null);
        } catch { d.slipRow = null; }
      }
      // statement: 안의 인보이스가 이미 장부에 있으면 중복이라 새 행 없음, 없으면 일반 증빙처럼 1행 기장
      if (!(d.docType === 'statement' && !d.slipRow)) return;
      d.state = 'reading'; d.slip = undefined;
    }
    if (d.docType === 'cash_withdrawal' && !d.manualCategory) return pattyExtraction(d, out);
    d.kind = undefined;
    const items = Array.isArray(out.items) ? out.items : [];
    Object.assign(d, {
      date: out.date || '', vendor: out.vendor || '', receiptNo: String(out.receipt_no || '').replace(/^["'\s]+|["'\s]+$/g, ''), relatedNo: out.related_no || '',
      items, details: detailsText(items), currency: String(out.currency || 'HKD').trim().toUpperCase(),
      amount: Number(out.total) || 0, notes: out.notes || '', purpose: out.purpose || '',
    });
    const fxr = await rateFor(d, cfg);
    const conv = toHKD(d.amount, d.currency, fxr.rate);
    d.rate = conv.rate; d.hkd = d.hkdManual ?? conv.hkd; d.rateSource = d.hkdManual != null ? '담당자가 HKD 직접 입력' : fxr.source;
    const cls = d.manualCategory ? { category: d.manualCategory, reason: '담당자가 직접 선택', needsReview: false } : classify(items, d.vendor, vs);
    Object.assign(d, { category: cls.category, reason: cls.reason });

    // D08·D09 기존 장부 대조
    d.dup = null;
    try {
      const rows = await sheets.listLedger();
      if (d.docType === 'credit_note') {
        const orig = d.relatedNo && rows.find((r) => sameDocNo(r.receiptNo, d.relatedNo));
        d.dup = orig ? { kind: 'credit_note', row: orig } : { kind: 'credit_note', row: null };
      } else {
        d.dup = findDuplicate(rows, d);
        // 같은 번호인데 금액만 다른 '수정본'처럼 보여도, 그 차이가 이미 반영된 Credit Note 차감 때문이면 같은 인보이스 재전송(중복)
        if (d.dup?.kind === 'revision') {
          const cn = [...String(d.dup.row.details || '').matchAll(/Credit Note[^/]*?-\s*([\d,]+(?:\.\d+)?)/gi)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0);
          if (cn > 0 && Math.abs(round2(Number(d.dup.row.amount) + cn) - Number(d.amount)) < 0.01) d.dup = { ...d.dup, kind: 'duplicate', creditNoted: cn };
        }
      }
    } catch (e) { log.warn?.('장부 대조 실패', e.message); d.dupError = true; }

    d.flags = [
      cls.needsReview ? `분류 확인: ${cls.reason}` : null,
      d.hkd == null ? 'HKD 금액을 정할 수 없음 — 답장으로 "HKD 금액"을 알려 주세요' : null,
      fxr.warn ? fxr.source : null,
      d.dup?.kind === 'duplicate' ? `이미 장부에 있는 증빙 같아요: ${d.dup.row.tab} ${d.dup.row.no}${d.dup.creditNoted ? ` (Credit Note ${fmtMoney(d.dup.creditNoted)} 차감 반영된 건)` : ''}` : null,
      d.dup?.kind === 'possible_duplicate' ? `번호 없는 증빙 — 같은 날짜·금액 기록이 있어요: ${d.dup.row.tab} ${d.dup.row.no}` : null,
      d.dup?.kind === 'revision' ? `같은 번호의 기존 기록이 있어요(수정본) → 승인하면 ${d.dup.row.tab} ${d.dup.row.no} 행을 수정해요` : null,
      d.dup?.kind === 'credit_note' && d.dup.row ? `Credit Note → 승인하면 원본 ${d.dup.row.tab} ${d.dup.row.no} 행 금액을 차감해 수정해요` : null,
      d.dup?.kind === 'credit_note' && !d.dup.row ? `Credit Note인데 원본 인보이스(${d.relatedNo || '번호 없음'})를 장부에서 못 찾았어요` : null,
      d.dupError ? '장부 중복 확인을 못 했어요' : null,
      d.ai?.mismatch ? `증빙끼리 금액이 달라요: ${d.ai.mismatch}` : null,
      !d.receiptNo ? `영수증 번호 없음 → 저장 시 내부 번호(${d.category === 'Expenses' ? 'Basic_번호' : d.category === 'Purchase_Drink' ? 'YYYY PURD (번호)' : 'YYYY PURF (번호)'})로 입력` : null,
    ].filter(Boolean);
    if (!d.firstSnapshot) d.firstSnapshot = snapshot(d);
    d.state = 'pending';
  }
  /** 은행 현금 인출 통지서 → 'Patty Cash Record' 1행 후보 */
  async function pattyExtraction(d, out) {
    Object.assign(d, {
      kind: 'patty', category: '', reason: '은행 현금 인출 → 패티캐쉬 기록',
      date: out.date || '', vendor: out.vendor || 'Bank', receiptNo: '', currency: 'HKD', items: [], purpose: '',
      amount: Number(out.total) || 0, notes: out.notes || '', handwritten: out.handwritten || '',
    });
    if (d.amountManual != null) d.amount = d.amountManual;
    d.hkd = d.amount;
    d.pattyDesc = d.pattyDesc || PATTY_DEFAULT_DESC;
    d.details = d.pattyDesc;
    if (d.remark == null) d.remark = remarkFromText(d.message) ?? (d.message || '');
    let dupRow = null;
    try {
      const ymd = String(d.date).slice(0, 10);
      dupRow = (await sheets.listPatty()).find((r) => String(r.date).slice(0, 10) === ymd && Math.abs(Number(r.amount) - d.amount) < 0.005);
    } catch (e) { log.warn?.('패티캐쉬 대조 실패', e.message); }
    d.flags = [
      d.handwritten ? `손글씨 메모가 있어요: "${d.handwritten}" — 금액이 다르면 "총액 7470"처럼 답장` : null,
      dupRow ? `같은 날짜·금액의 패티캐쉬 기록이 있어요: ${dupRow.no}` : null,
      !d.remark ? '리마크가 비어 있어요 — 올린 사람이 "리마크 내용"으로 답장할 수 있어요' : null,
    ].filter(Boolean);
    if (!d.firstSnapshot) d.firstSnapshot = snapshot(d);
    d.state = 'pending';
  }

  const snapshot = (d) => ({ 날짜: d.date, 업체: d.vendor, 영수증번호: d.receiptNo, 상세내역: d.details, 통화: d.currency, 금액: d.amount, HKD: d.hkd, 시트: d.category });

  const moneyLine = (d) => (d.currency === 'HKD'
    ? `HKD ${fmtMoney(d.amount)}`
    : `${d.currency} ${fmtMoney(d.amount)} → ${d.hkd == null ? 'HKD 미정' : `HKD ${fmtMoney(d.hkd)}`}${d.rateSource ? `\n  (${d.rateSource}${d.rate && d.rate !== 1 ? `, 환율 ${round2(d.rate * 1e4) / 1e4}` : ''})` : ''}`);

  /** 현업이 읽는 근거 문구: 개발용 결정 코드([D10-1] 등)는 빼고 보여 준다 (AI_Log에는 코드 포함 원문 보관) */
  const plainReason = (r) => String(r || '').replace(/\s*\[D\d+(?:[-·]\d+)*\]/g, '').trim();

  /** 승인 카드 맨 위 경고: WhatsApp은 색을 못 쓰므로 이모지 + *굵게* 로 눈에 띄게 */
  function warnBlock(d) {
    if (!d.flags?.length) return null;
    const strong = (f) => /HKD 금액을 정할 수 없음|이미 장부|같은 날짜·금액|중복|금액이 달라요|행을 수정|수정본|차감|원본 인보이스/.test(f);
    const lines = d.flags.map((f) => (strong(f) ? `🚨 *${plainReason(f)}*` : `ℹ️ ${plainReason(f)}`));
    return `\n${lines.join('\n')}\n`;
  }

  function body(d, forApprover) {
    const head = forApprover ? `📋 *승인 요청* ${d.id}${d.v > 1 ? ` (수정 ${d.v - 1})` : ''}` : `📥 *접수했어요* (${d.id})`;
    if (d.kind === 'patty') {
      return [
        head,
        forApprover ? warnBlock(d) : null,
        forApprover ? `👤 올린 사람: ${d.name}` : null,
        `🗂️ 시트: ${PATTY_TAB}`,
        `📅 날짜: ${d.date || '-'}`,
        `🏦 내용: ${d.pattyDesc}`,
        `💰 캐쉬인: HKD ${fmtMoney(d.amount)}`,
        `📝 리마크: ${d.remark || '-'}`,
        '',
        forApprover ? '고칠 내용은 답장으로 보내세요 (예: "총액 7470", "리마크 2026 07 Bonus").'
          : '회계 담당 승인 후 Patty Cash Record에 저장돼요. 리마크는 사진에 답장으로 남기면 돼요.',
      ].filter((x) => x !== null).join('\n');
    }
    const sheet = CATEGORIES[d.category] || '미정 (회계 담당이 고름)';
    if (!forApprover) {
      // 직원용: 무엇이 접수됐는지만 짧게, 항목마다 아이콘
      return [
        head,
        ...(d.flags || []).filter((f) => /이미 장부|같은 날짜·금액|행을 수정|수정본/.test(f)).map((f) => `🚨 *${plainReason(f).replace(/ →.*$/, '')}* — 회계 담당이 확인해요`),
        `🏪 ${d.vendor || '-'}`,
        `📅 ${d.date || '-'}`,
        `💰 ${moneyLine(d).split('\n')[0]}`,
        `🛒 ${d.details || '-'}`,
        d.prepaid ? `💳 ${prepaidRef(d.name, d.refTpl)}` : null,
        '',
        '회계 담당 승인 후 장부에 저장돼요. 틀린 곳은 답장으로 알려 주세요.',
      ].filter((x) => x !== null).join('\n');
    }
    return [
      head,
      warnBlock(d),
      `👤 올린 사람: ${d.name}`,
      `🗂️ 시트: ${sheet}${d.reason ? ` — ${plainReason(d.reason)}` : ''}`,
      `🏪 업체: ${d.vendor || '-'}`,
      `📅 날짜: ${d.date || '-'}`,
      `🔢 영수증번호: ${d.receiptNo || '-'}${d.docType === 'credit_note' ? ' (Credit Note)' : ''}`,
      `🛒 내역: ${d.details || '-'}`,
      d.purpose ? `🎯 목적: ${d.purpose}` : null,
      `💰 금액: ${moneyLine(d)}`,
      d.prepaid ? `💳 REF: ${prepaidRef(d.name, d.refTpl)}` : null,
      '',
      '고칠 내용은 답장으로 보내세요 (예: "분류 Drink", "총액 1200").',
    ].filter((x) => x !== null).join('\n');
  }

  // ---------- 승인자에게 보내기 (24시간 창 처리) ----------
  async function toApprover(phone, fn) {
    try { await fn(); return true; } catch (e) {
      if (e.code === 131047 || /re-?engagement|24 hours|outside.*window/i.test(e.message)) {
        needsNotify.add(phone);
        if (approvalTemplate) await wa.sendTemplate(phone, approvalTemplate, templateLang).catch((x) => log.error?.('템플릿 발송 실패', x.message));
        return false;
      }
      throw e;
    }
  }

  async function sendCard(d, approverList) {
    const okTitle = d.dup?.kind === 'revision' || (d.dup?.kind === 'credit_note' && d.dup.row) ? '기존 행 수정'
      : d.dup?.kind === 'duplicate' ? '그래도 저장' : '승인·저장';
    const buttons = [
      { id: `ok:${d.id}:${d.v}`, title: okTitle },
      { id: `cat:${d.id}:${d.v}`, title: '분류 변경' },
      { id: `rej:${d.id}:${d.v}`, title: '반려' },
    ];
    let delivered = 0;
    for (const a of approverList) {
      focus.set(a, d.id);
      if (await toApprover(a, () => wa.sendButtons(a, body(d, true), buttons))) delivered++;
    }
    return delivered;
  }

  /** 판독 결과에 따라 다음 단계로 */
  async function route(d) {
    const { approvers: apprs } = await people();
    if (d.state === 'asking') {
      const q = d.ai?.question || '영수증을 읽기 어려워요. 날짜·업체·총액을 알려 주시겠어요?';
      const missing = Array.isArray(d.ai?.missing) ? d.ai.missing : [];
      if (missing.length === 1 && missing[0] === 'date') {
        // 날짜만 안 보이면 최근 1주일 날짜 + 취소를 목록으로 제안 (추측해서 넣지 않고 올린 사람이 고른다)
        const names = ['오늘', '어제', '그제'];
        const rows = [0, 1, 2, 3, 4, 5, 6].map((n) => { const ymd = ymdOffset(-n); return { id: `date:${d.id}:${ymd}`, title: `${names[n] || `${n}일 전`} ${ymd.slice(5).replace('-', '/')}` }; });
        rows.push({ id: `cancel:${d.id}`, title: '취소', description: '이 접수를 취소해요' });
        await wa.sendList(d.phone, `📅 ${q}\n\n아래 [날짜 고르기]에서 고르거나, 다른 날짜면 "날짜 10/20"처럼 답장해 주세요.`, '날짜 고르기', rows);
        return persist();
      }
      await wa.sendButtons(d.phone, `${q}\n(답장해 주시면 반영해서 다시 읽을게요.)`, [{ id: `cancel:${d.id}`, title: '취소' }]);
      return persist();
    }
    if (d.state === 'notdoc') {
      const what = { other: '거래 증빙(영수증·인보이스)이 아닌 것', statement: '거래명세서(statement)', payment_slip: '송금 확인·카드 결제 알림' }[d.docType];
      let next;
      if (d.docType === 'statement' && d.slipRow) {
        const r = d.slipRow;
        next = `이 statement의 인보이스는 이미 장부에 있어요: ${r.tab} ${r.no} (${r.vendor}, HKD ${fmtMoney(r.hkd)}). statement는 새 매입으로 넣지 않아요.\n그래도 새로 넣어야 하면 "등록"이라고 보내 주세요.`;
      } else if (d.docType === 'payment_slip' && d.slipRow) {
        const r = d.slipRow;
        next = `장부에 이미 같은 금액 건이 있어요: ${r.tab} ${r.no} (${r.vendor}, HKD ${fmtMoney(r.hkd)}). 그 건의 지급 확인이면 새로 넣지 않아도 돼요.\n선지불 입금 완료라면 "${r.no} 입금완료", 다른 지출이라 새로 넣어야 하면 "등록"이라고 보내 주세요.`;
      } else if (d.docType === 'payment_slip') {
        next = '영수증·인보이스가 따로 있으면 그걸 보내 주세요. 이 송금 확인만으로 장부에 넣으려면 "등록", 선지불 입금 완료라면 "번호 입금완료"라고 보내 주세요.';
      } else {
        next = '장부에 넣어야 하는 증빙이면 "등록"이라고 답장해 주세요. 아니면 "취소".';
      }
      await wa.sendButtons(d.phone, `${what} 같아요.\n${next}`, [{ id: `reg:${d.id}`, title: '등록' }, { id: `cancel:${d.id}`, title: '취소' }]);
      return persist();
    }
    d.v = (d.v || 0) + 1;
    const list = apprs.length ? apprs : [d.phone]; // 승인자 미지정이면 올린 사람이 직접 승인
    const delivered = await sendCard(d, list);
    if (apprs.length && !apprs.includes(d.phone)) {
      // 직원이 잘못 보냈거나 중복이면 바로 취소할 수 있게 [취소] 버튼
      await wa.sendButtons(d.phone, delivered
        ? body(d, false)
        : `${body(d, false)}\n\n(회계 담당에게 바로 알리지 못했어요. 회계 담당이 비서에게 메시지를 보내면 이 건이 표시돼요.)`,
      [{ id: `cancel:${d.id}`, title: '취소' }]);
    }
    persist();
  }

  // ---------- 접수 ----------
  async function startDraft(input, who) {
    const all = Array.isArray(input) ? input : [input];
    const msgs = all.filter((m) => SUPPORTED_MIME.includes((m.mimeType || '').split(';')[0]));
    if (msgs.length < all.length) await wa.sendText(all[0].from, '사진(JPG/PNG) 또는 PDF로 보내 주세요.');
    if (!msgs.length) return;
    const msg = msgs[0];
    const cfg = await config();
    const d = {
      id: newId(), v: 0, phone: msg.from, name: who.name, message: msgs.map((m) => m.text).filter(Boolean).join(' / '), answers: [], mediaId: msg.mediaId,
      ...(msgs.length > 1 ? { mediaIds: msgs.map((m) => m.mediaId) } : {}),
      prepaid: msgs.some((m) => isPrepaidText(m.text)) || (Date.now() - (prepaidHint.get(msg.from) || 0) < 5 * 60e3),
      refTpl: cfg.REF_PREPAID || DEFAULT_REF.prepaid, createdAt: Date.now(), sourceMessageId: msg.id, state: 'reading',
    };
    prepaidHint.delete(msg.from);
    drafts.set(d.id, d); latest.set(d.phone, d.id);
    await wa.sendText(d.phone, msgs.length > 1 ? `사진 ${msgs.length}장을 받았어요. 함께 읽는 중이에요…` : '받았어요. 읽는 중이에요…');
    await runExtraction(d);
    const rest = d.split || [];
    delete d.split;
    if (rest.length) {
      const n = rest.length + 1;
      await wa.sendText(d.phone, `사진에 영수증이 ${n}장 있어서 ${n}건으로 나눠 접수했어요 (영수증 1장 = 장부 1행).`);
    }
    await route(d);
    for (let i = 0; i < rest.length; i++) {
      const r = rest[i];
      const sib = { ...d, id: newId(), v: 0, answers: [], firstSnapshot: undefined, flags: undefined, dup: null, state: 'reading', createdAt: Date.now(),
        part: { index: i + 2, total: rest.length + 1, receiptNo: r.receipt_no || '', amount: r.total } };
      if (media.has(d.id)) media.set(sib.id, media.get(d.id));
      drafts.set(sib.id, sib); latest.set(sib.phone, sib.id);
      await runExtraction(sib, r);
      await route(sib);
    }
  }

  /** 올린 사람 또는 승인자의 정정 → 다시 판독 후 다시 승인 요청 */
  async function correct(d, text, fromApprover) {
    d.answers.push(fromApprover ? `[회계 담당] ${text}` : text);
    if (d.kind === 'patty') {
      // 패티캐쉬: 리마크·금액·내용은 다시 읽지 않고 바로 반영
      const rm = remarkFromText(text);
      const amt = String(text).match(/^\s*(?:총액|금액|amount)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*$/i);
      const desc = String(text).match(/^\s*(?:내용|설명)\s*[:：]?\s*(.+)$/s);
      if (rm != null || amt || desc) {
        if (rm != null) d.remark = rm;
        if (amt) d.amountManual = Number(amt[1].replace(/,/g, ''));
        if (desc) d.pattyDesc = desc[1].trim();
        await pattyExtraction(d, d.ai || {});
        return route(d);
      }
    }
    const h = hkdOverride(text);
    if (h != null) d.hkdManual = h;
    const cat = /분류|시트/.test(text) && CAT_WORDS.find(([re]) => re.test(text));
    if (cat) { d.manualCategory = cat[1]; }
    if (isPrepaidText(text) && !fromApprover) d.prepaid = true;
    const to = fromApprover ? (d._approverPhone || d.phone) : d.phone;
    await wa.sendText(to, '반영해서 다시 확인하는 중이에요…').catch(() => {});
    await runExtraction(d);
    await route(d);
  }

  // ---------- 승인 ----------
  let lock = Promise.resolve();
  const withLock = (fn) => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };

  async function approve(d, approverPhone, approverName) {
    if (d.kind === 'patty') return approvePatty(d, approverPhone, approverName);
    if (!d.category) return askCategory(d, approverPhone, '시트(분류)를 먼저 골라 주세요.');
    if (d.hkd == null) return wa.sendText(approverPhone, `${d.id}: HKD 금액을 정할 수 없어요. "HKD 금액"을 답장으로 보내 주세요 (예: "HKD 732.37").`);
    const cfg = await config();
    const year = hkYear();
    const fileLabel = String(cfg.FILE_LABEL || '').replace(/\{year\}/g, year);
    const ref = d.prepaid ? prepaidRef(d.name, cfg.REF_PREPAID || DEFAULT_REF.prepaid) : '';

    const result = await withLock(async () => {
      const editRow = d.dup?.kind === 'revision' ? d.dup.row : d.dup?.kind === 'credit_note' ? d.dup.row : null;
      if (editRow) {
        // D09 기존 행 수정 (번호 유지)
        const fresh = (await sheets.listLedger()).find((r) => r.tab === editRow.tab && r.no === editRow.no) || editRow;
        let vals;
        if (d.docType === 'credit_note') {
          const amt = round2(Number(fresh.amount) - d.amount);
          const hkd = round2(Number(fresh.hkd) - d.hkd);
          vals = [fresh.file, fresh.receiptNo, fresh.date, fresh.vendor, fresh.currency, `${fresh.details} / Credit Note ${d.receiptNo || ''} -${fmtMoney(d.amount)}`.trim(), amt, hkd, fresh.payDate, fresh.account, fresh.ref];
        } else {
          vals = [fresh.file || fileLabel, d.receiptNo, ymdNumber(d.date), d.vendor, d.currency, d.details, d.amount, d.hkd, fresh.payDate, fresh.account, ref || fresh.ref];
        }
        await sheets.updateLedgerRow(fresh.tab, fresh.rowNumber, vals);
        return { tab: fresh.tab, no: fresh.no, rowNumber: fresh.rowNumber, revised: true };
      }
      // 저장 직전 재확인: 카드를 만든 뒤 같은 증빙이 먼저 저장됐을 수 있다(연달아 두 번 보낸 경우)
      if (d.docType !== 'credit_note') {
        const late = findDuplicate(await sheets.listLedger(), d);
        const known = d.dup?.row && late?.row && d.dup.row.tab === late.row.tab && d.dup.row.no === late.row.no;
        if (late && ['duplicate', 'possible_duplicate'].includes(late.kind) && !known) return { blocked: late };
      }
      const tab = CATEGORIES[d.category];
      const no = nextNo(d.category, await sheets.columnA(tab), year);
      const row = [no, fileLabel, d.receiptNo || fallbackReceiptNo(no, d.category, year), ymdNumber(d.date), d.vendor, d.currency, d.details, d.amount, d.hkd, '', '', ref];
      const rowNumber = await sheets.insertLedgerRow(tab, row);
      return { tab, no, rowNumber, revised: false };
    });

    if (result.blocked) {
      d.dup = result.blocked;
      const f = `${result.blocked.kind === 'duplicate' ? '이미 장부에 있는 증빙 같아요' : '번호 없는 증빙 — 같은 날짜·금액 기록이 있어요'}: ${result.blocked.row.tab} ${result.blocked.row.no}`;
      d.flags = [f, ...(d.flags || []).filter((x) => !/이미 장부|같은 날짜·금액/.test(x))];
      await wa.sendText(approverPhone, `${d.id}: 저장 직전에 확인해 보니 같은 증빙이 방금 저장됐어요(${result.blocked.row.tab} ${result.blocked.row.no}). 저장하지 않았어요. 새 카드를 확인해 주세요.`);
      d.v = (d.v || 0) + 1;
      await sendCard(d, [approverPhone]);
      return persist();
    }
    const final = snapshot(d);
    const changed = Object.keys(final).filter((k) => String(final[k] ?? '') !== String(d.firstSnapshot?.[k] ?? ''));
    await sheets.appendLog({
      처리ID: d.id, 상태: result.revised ? '기존 행 수정' : '저장', 시트: result.tab, 'No.': result.no, 영수증번호: d.receiptNo, 업체: d.vendor,
      통화: d.currency, 금액: d.amount, HKD: d.hkd, '분류 근거': d.reason, 올린사람: d.name, 올린사람번호: d.phone, 승인자: approverName,
      원메시지ID: d.sourceMessageId, 미디어ID: d.mediaId, '메시지·정정': [d.message, ...d.answers].filter(Boolean).join(' / '),
      'AI 원본': d.ai, AI대비수정: changed.join(', ') || '없음', '환율 근거': d.rateSource, '구매 목적': d.purpose, 생성시각: new Date(d.createdAt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), 처리시각: hkStamp(),
    }).catch((e) => log.warn?.('AI_Log 기록 실패', e.message));

    drafts.delete(d.id); media.delete(d.id);
    persist();
    const where = `${result.tab} ${result.no} (${result.rowNumber}행)`;
    await wa.sendText(approverPhone, `${result.revised ? '기존 행을 수정했어요' : '장부에 저장했어요'}: ${where}`);
    if (d.phone !== approverPhone) {
      const done = `✅ 회계 승인 완료 — ${where}${result.revised ? ' 기존 행 수정' : '에 저장'}됐어요.`;
      if (d.prepaid) await wa.sendButtons(d.phone, `${done}\n💳 선지불 건이에요. 입금받으면 아래 버튼을 눌러 주세요.`, [{ id: `paid:${result.no}`, title: '입금완료' }]).catch(() => {});
      else await wa.sendText(d.phone, done).catch(() => {});
    } else if (d.prepaid) {
      await wa.sendButtons(d.phone, `💳 선지불 건이에요. 입금받으면 아래 버튼을 눌러 주세요.`, [{ id: `paid:${result.no}`, title: '입금완료' }]);
    }
  }

  async function approvePatty(d, approverPhone, approverName) {
    const result = await withLock(async () => {
      const no = nextNo('Purchase_Food', await sheets.columnA(PATTY_TAB), hkYear()); // 탭 안 일련번호 #N
      const row = [no, String(d.date).slice(0, 10), d.pattyDesc, '', d.amount, d.remark || ''];
      const rowNumber = await sheets.insertLedgerRow(PATTY_TAB, row);
      return { tab: PATTY_TAB, no, rowNumber };
    });
    await sheets.appendLog({
      처리ID: d.id, 상태: '저장', 시트: PATTY_TAB, 'No.': result.no, 업체: d.vendor, 통화: 'HKD', 금액: d.amount, HKD: d.amount,
      '분류 근거': d.reason, 올린사람: d.name, 올린사람번호: d.phone, 승인자: approverName, 원메시지ID: d.sourceMessageId, 미디어ID: d.mediaId,
      '메시지·정정': [d.message, ...d.answers].filter(Boolean).join(' / '), 'AI 원본': d.ai, '구매 목적': d.remark,
      생성시각: new Date(d.createdAt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), 처리시각: hkStamp(),
    }).catch((e) => log.warn?.('AI_Log 기록 실패', e.message));
    drafts.delete(d.id); media.delete(d.id); persist();
    const where = `${PATTY_TAB} ${result.no} (${result.rowNumber}행)`;
    await wa.sendText(approverPhone, `장부에 저장했어요: ${where}`);
    if (d.phone !== approverPhone) await wa.sendText(d.phone, `회계 승인 완료 — ${where}에 저장됐어요.`).catch(() => {});
  }

  async function askCategory(d, phone, text) {
    await toApprover(phone, () => wa.sendList(phone, `${d.id} ${text}`, '시트 선택', Object.entries(CATEGORIES).map(([k, label]) => ({ id: `set:${d.id}:${d.v}:${k}`, title: label }))));
  }

  // ---------- 입금완료 (D11) ----------
  async function handlePaid(msg, who, isApprover) {
    const rows = await sheets.listLedger();
    const found = findPrepaidRow(rows, msg.text);
    const open = found.open;
    // [입금완료] 버튼: 번호가 정확히 지정됨 (짧은 번호 #1도 OK). 이미 입금완료면 open에 없음
    const hit = msg.paidNo ? open.find((r) => r.no === msg.paidNo) || null : found.hit;
    if (msg.paidNo && !hit) return wa.sendText(msg.from, `${msg.paidNo}는 이미 입금완료로 반영됐거나 찾을 수 없어요.`);
    if (!hit) {
      const list = open.slice(-5).map((r) => `- ${r.no} / ${r.receiptNo} (${r.vendor}, HKD ${fmtMoney(r.hkd)})`).join('\n');
      await wa.sendText(msg.from, open.length
        ? `어느 건인지 찾지 못했어요. 입금 전 선지불 건:\n${list}\n번호와 함께 "입금완료"를 보내 주세요.`
        : '입금 전 상태인 선지불 건이 없어요.');
      return;
    }
    const cfg = await config();
    const ref = paidRef(prepaidNameFromRef(hit.ref), cfg.REF_PAID || DEFAULT_REF.paid);
    // 지급일 = 입금했다고 알린 메시지의 날짜(홍콩), 계좌 = Config 기본값
    const paidDate = hkDateNumber(msg.timestamp || Date.now());
    const account = String(cfg.PAYMENT_ACCOUNT_DEFAULT || '').trim();
    const { approvers: apprs } = await people();
    if (isApprover || !apprs.length) {
      await applyPaid({ hit, ref, paidDate, account, reporter: who.name, approver: who.name });
      await wa.sendText(msg.from, `${hit.tab} ${hit.no} (${hit.vendor}, HKD ${fmtMoney(hit.hkd)}) 입금완료를 반영했어요.\n지급일: ${fmtYmd(paidDate)}\nREF → ${ref}`);
      return;
    }
    const p = { id: newId('P'), hit, ref, paidDate, account, reporter: who.name, reporterPhone: msg.from, createdAt: Date.now() };
    paidReqs.set(p.id, p);
    for (const a of apprs) await toApprover(a, () => wa.sendButtons(a, paidCard(p), [{ id: `pok:${p.id}`, title: '반영' }, { id: `pno:${p.id}`, title: '무시' }]));
    await wa.sendText(msg.from, `${hit.no} 입금완료 보고를 회계 담당에게 보냈어요. 확인되면 장부 REF가 바뀌어요.`);
    persist();
  }
  const paidCard = (p) => `[입금완료 확인] ${p.hit.tab} ${p.hit.no}\n업체: ${p.hit.vendor}\n금액: HKD ${fmtMoney(p.hit.hkd)}\n보고: ${p.reporter}\n지급일: ${fmtYmd(p.paidDate)}${p.account ? `\n계좌: ${p.account}` : ''}\n현재 REF: ${p.hit.ref}\n바꿀 REF: ${p.ref}`;
  async function applyPaid({ hit, ref, paidDate, account, reporter, approver }) {
    const fresh = (await sheets.listLedger()).find((r) => r.tab === hit.tab && r.no === hit.no) || hit;
    paidDate = paidDate || hkDateNumber(Date.now());
    await sheets.updatePaid(fresh.tab, fresh.rowNumber, { paidDate, account, ref });
    await sheets.appendLog({ 처리ID: hit.no, 상태: '입금완료 반영', 시트: hit.tab, 'No.': hit.no, 영수증번호: hit.receiptNo, 업체: hit.vendor, HKD: hit.hkd, 올린사람: reporter, 승인자: approver, '메시지·정정': `${ref} / 지급일 ${paidDate}${account ? ' / ' + account : ''}`, 처리시각: hkStamp() })
      .catch((e) => log.warn?.('AI_Log 기록 실패', e.message));
  }

  // ---------- 버튼 ----------
  async function handleReply(msg, who, isApprover) {
    const [action, id, v, extra] = String(msg.replyId).split(':');
    if (action === 'paid') return handlePaid({ ...msg, text: `${id} 입금완료`, paidNo: id }, who, isApprover);
    if (action === 'cancel' || action === 'reg') {
      const d = drafts.get(id);
      if (!d || d.phone !== msg.from || !['asking', 'notdoc', 'pending'].includes(d.state)) return wa.sendText(msg.from, '이 건은 이미 처리됐거나 만료됐어요.');
      if (action === 'cancel') {
        const wasPending = d.state === 'pending';
        drafts.delete(d.id); media.delete(d.id); persist();
        if (wasPending) { // 승인 카드가 이미 갔으면 회계 담당에게도 알림
          const { approvers: apprs } = await people();
          for (const a of apprs.filter((x) => x !== msg.from)) await toApprover(a, () => wa.sendText(a, `${d.id} (${d.vendor || '-'}, ${moneyLine(d).split('\n')[0]})는 올린 사람이 취소했어요. 승인하지 않아도 돼요.`)).catch(() => {});
        }
        return wa.sendText(msg.from, `${d.id}를 취소했어요.`);
      }
      d.forceReceipt = true;
      return correct(d, '등록', false);
    }
    if (action === 'date') {
      const d = drafts.get(id);
      if (!d || d.state !== 'asking') return wa.sendText(msg.from, '이 건은 이미 처리됐거나 만료됐어요.');
      return correct(d, `날짜 ${v}`, false);
    }
    if (action === 'pok' || action === 'pno') {
      const p = paidReqs.get(id);
      if (!p) return wa.sendText(msg.from, '이미 처리된 요청이에요.');
      paidReqs.delete(id); persist();
      if (action === 'pno') return wa.sendText(msg.from, `${p.hit.no} 입금완료 보고를 반영하지 않았어요.`);
      await applyPaid({ hit: p.hit, ref: p.ref, paidDate: p.paidDate, account: p.account, reporter: p.reporter, approver: who.name });
      await wa.sendText(msg.from, `${p.hit.no} 입금완료를 반영했어요.\n지급일: ${fmtYmd(p.paidDate || hkDateNumber(Date.now()))}\nREF → ${p.ref}`);
      if (p.reporterPhone !== msg.from) await wa.sendText(p.reporterPhone, `${p.hit.no} 입금완료가 장부에 반영됐어요.`).catch(() => {});
      return;
    }
    const d = drafts.get(id);
    if (!d) return wa.sendText(msg.from, '이 건은 이미 처리됐거나 만료됐어요.');
    const { approvers: apprs } = await people();
    const canApprove = apprs.length ? isApprover : d.phone === msg.from;
    if (!canApprove) return wa.sendText(msg.from, '승인은 회계 담당만 할 수 있어요.');
    if (String(d.v) !== String(v)) return wa.sendText(msg.from, `${d.id}는 내용이 바뀌어 새 카드로 다시 보냈어요. 최신 카드에서 눌러 주세요.`);
    focus.set(msg.from, d.id);
    if (action === 'ok') return approve(d, msg.from, who.name);
    if (action === 'cat') return askCategory(d, msg.from, '시트(분류)를 골라 주세요.');
    if (action === 'set' && CATEGORIES[extra]) {
      d.manualCategory = extra;
      if (d.kind === 'patty') { d.kind = undefined; d.firstSnapshot = undefined; await runExtraction(d, d.ai); }
      d.category = extra; d.reason = '담당자가 직접 선택';
      d.flags = (d.flags || []).filter((f) => !f.startsWith('분류 확인'));
      return route(d);
    }
    if (action === 'rej') {
      drafts.delete(d.id); media.delete(d.id); persist();
      await sheets.appendLog({ 처리ID: d.id, 상태: '반려', 업체: d.vendor, 영수증번호: d.receiptNo, 금액: d.amount, 올린사람: d.name, 올린사람번호: d.phone, 승인자: who.name, 'AI 원본': d.ai, 처리시각: hkStamp() }).catch(() => {});
      await wa.sendText(msg.from, `${d.id}를 반려했어요.`);
      if (d.phone !== msg.from) await wa.sendText(d.phone, `${d.id} (${d.vendor || '영수증'})는 회계 담당이 반려했어요. 궁금한 점은 회계 담당에게 문의해 주세요.`).catch(() => {});
    }
  }

  // ---------- 글자 ----------
  async function resendPending(phone) {
    const list = [...drafts.values()].filter((d) => d.state === 'pending');
    const paids = [...paidReqs.values()];
    if (!list.length && !paids.length) return wa.sendText(phone, '승인 대기 중인 건이 없어요.');
    for (const d of list) { focus.set(phone, d.id); await sendCard(d, [phone]); }
    for (const p of paids) await wa.sendButtons(phone, paidCard(p), [{ id: `pok:${p.id}`, title: '반영' }, { id: `pno:${p.id}`, title: '무시' }]);
  }

  /** 사진에 '답장'으로 보낸 글 → 아직 승인 전이면 그 건 정정, 이미 저장된 패티캐쉬면 리마크 수정 */
  async function handleContextReply(msg, t) {
    const d = [...drafts.values()].find((x) => x.sourceMessageId === msg.contextId && x.phone === msg.from);
    if (d) {
      if (isCancelText(t)) { drafts.delete(d.id); media.delete(d.id); persist(); await wa.sendText(msg.from, `${d.id}를 취소했어요.`); return true; }
      if (d.kind === 'patty' && remarkFromText(t) == null && !/^\s*(총액|금액|내용|설명)/.test(t)) { await correct(d, `리마크 ${t}`, false); return true; }
      await correct(d, t, false); return true;
    }
    let saved = null;
    try { saved = await sheets.findSavedBySource(msg.contextId); } catch (e) { log.warn?.('답장 대상 찾기 실패', e.message); }
    if (!saved) return false;
    if (saved.tab !== PATTY_TAB) {
      await wa.sendText(msg.from, `${saved.tab} ${saved.no}는 이미 장부에 저장된 건이에요. 고칠 내용은 회계 담당에게 알려 주세요.`);
      return true;
    }
    const remark = remarkFromText(t) ?? t;
    const row = await sheets.updatePattyRemark(saved.no, remark);
    if (!row) return false;
    await sheets.appendLog({ 처리ID: saved.id, 상태: '리마크 수정', 시트: PATTY_TAB, 'No.': saved.no, 올린사람번호: msg.from, '메시지·정정': remark, 원메시지ID: msg.contextId, 처리시각: hkStamp() }).catch(() => {});
    await wa.sendText(msg.from, `${PATTY_TAB} ${saved.no} 리마크를 바꿨어요.\n→ ${remark}`);
    return true;
  }

  async function handleText(msg, who, isApprover) {
    const t = (msg.text || '').trim();
    if (msg.contextId && t && (await handleContextReply(msg, t))) return;
    if (/^(도움말|help|\?|사용법)$/i.test(t)) return wa.sendText(msg.from, isApprover ? `${HELP_APPROVER}\n\n${HELP_STAFF}` : HELP_STAFF);
    if (isApprover && /^(대기|목록|pending)$/i.test(t)) return resendPending(msg.from);
    if (isPaidText(t)) {
      const slip = drafts.get(latest.get(msg.from));
      if (slip?.state === 'notdoc') { drafts.delete(slip.id); media.delete(slip.id); persist(); } // 송금 확인 사진 → 입금완료로 처리
      return handlePaid(msg, who, isApprover);
    }

    // 내가 올린 건이 질문·확인 대기 중이면 그 건에 대한 답
    const mine = drafts.get(latest.get(msg.from));
    if (mine && ['asking', 'notdoc'].includes(mine.state)) {
      if (isCancelText(t)) { drafts.delete(mine.id); media.delete(mine.id); persist(); return wa.sendText(msg.from, `${mine.id}를 취소했어요.`); }
      if (mine.state === 'notdoc' && /^(등록|맞아|맞아요|yes)$/i.test(t)) mine.forceReceipt = true;
      return correct(mine, t, false);
    }
    // 승인자: 마지막으로 본 카드에 대한 정정
    const focused = isApprover && drafts.get(focus.get(msg.from));
    if (focused && focused.state === 'pending') {
      focused._approverPhone = msg.from;
      return correct(focused, t, true);
    }
    // 올린 사람: 승인 대기 중인 내 건 정정
    if (mine && mine.state === 'pending') {
      if (isCancelText(t)) { drafts.delete(mine.id); media.delete(mine.id); persist(); return wa.sendText(msg.from, `${mine.id}를 취소했어요.`); }
      if (isPrepaidText(t) && t.length <= 12) { mine.prepaid = true; return route(mine); }
      return correct(mine, t, false);
    }
    if (isPrepaidText(t)) { // 사진보다 "선지불"을 먼저 보낸 경우: 5분 안에 오는 영수증에 적용
      prepaidHint.set(msg.from, Date.now());
      return wa.sendText(msg.from, '선지불로 표시할게요. 영수증 사진을 보내 주세요.');
    }
    return wa.sendText(msg.from, '영수증 사진이나 PDF를 보내 주세요.\n사용법이 궁금하면 "도움말"이라고 보내 주세요.');
  }

  async function process(msg) {
    const p = await people();
    if (!p.allowAll && !p.allow.has(msg.from)) { log.warn?.('등록되지 않은 번호', msg.from); return; }
    const who = { name: p.staff.find((s) => s.phone === msg.from)?.name || msg.name || msg.from };
    const isApprover = p.approvers.includes(msg.from);
    wa.markRead(msg.id);
    try {
      if (isApprover && needsNotify.has(msg.from)) { // 24시간 창이 다시 열림 → 밀린 카드 전달
        needsNotify.delete(msg.from);
        await resendPending(msg.from);
        if (!msg.mediaId && !msg.replyId && !isPaidText(msg.text)) return;
      }
      if (msg.replyId) return await handleReply(msg, who, isApprover);
      if (msg.mediaId) {
        if (isPaidText(msg.text)) return await handlePaid(msg, who, isApprover);
        if (batchMs > 0) return collect(msg, who);
        return await startDraft(msg, who);
      }
      if (msg.type === 'text' || msg.type === 'button') return await handleText(msg, who, isApprover);
      // 사진 여러 장을 앨범으로 보내면 WhatsApp이 'unsupported' 묶음 메시지를 먼저 보낸다 → 곧 사진이 오면 안내하지 않음
      if (msg.type === 'unsupported' && batchMs > 0) {
        clearTimeout(unsupportedTimers.get(msg.from));
        unsupportedTimers.set(msg.from, setTimeout(() => {
          unsupportedTimers.delete(msg.from);
          wa.sendText(msg.from, UNSUPPORTED_TEXT).catch(() => {});
        }, Math.max(batchMs * 2, 3000)));
        return;
      }
      await wa.sendText(msg.from, UNSUPPORTED_TEXT);
    } catch (e) {
      log.error?.('처리 실패', msg.id, e);
      await wa.sendText(msg.from, '처리 중 문제가 생겼어요. 잠시 후 다시 보내 주세요.').catch(() => {});
    }
  }

  // 연달아 보낸 사진(예: 장바구니 화면 + 카드 결제 문자)은 batchMs 동안 모아 한 번에 읽는다
  const albums = new Map();
  const unsupportedTimers = new Map();
  function collect(msg, who) {
    clearTimeout(unsupportedTimers.get(msg.from)); unsupportedTimers.delete(msg.from);
    const a = albums.get(msg.from) || { msgs: [], who };
    a.msgs.push(msg);
    clearTimeout(a.timer);
    a.timer = setTimeout(() => {
      albums.delete(msg.from);
      const prev = queues.get(msg.from) || Promise.resolve();
      const next = prev.then(() => startDraft(a.msgs, a.who)).catch(async (e) => {
        log.error?.('묶음 처리 실패', e);
        await wa.sendText(msg.from, '처리 중 문제가 생겼어요. 잠시 후 다시 보내 주세요.').catch(() => {});
      });
      queues.set(msg.from, next);
    }, a.msgs.length >= 10 ? 0 : batchMs);
    albums.set(msg.from, a);
  }

  /** 웹훅 메시지 1건 처리. 중복 제거 + 발신자별 순차 처리. */
  function handle(msg) {
    gc();
    if (seen.has(msg.id)) return Promise.resolve();
    seen.set(msg.id, Date.now());
    const prev = queues.get(msg.from) || Promise.resolve();
    const next = prev.then(() => process(msg));
    queues.set(msg.from, next.catch(() => {}));
    return next;
  }

  /** 발송 결과 웹훅: 24시간 창이 닫혀 실패(131047)한 승인자는 다음에 말을 걸 때 밀린 카드를 보여 준다 */
  function handleStatus(s) {
    if (s?.status !== 'failed') return;
    if ((s.errors || []).some((e) => Number(e.code) === 131047)) {
      needsNotify.add(String(s.recipient_id));
      if (approvalTemplate) wa.sendTemplate(String(s.recipient_id), approvalTemplate, templateLang).catch(() => {});
    }
  }

  return { handle, handleStatus, restore, _drafts: drafts, _paid: paidReqs };
}

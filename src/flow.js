// 대화 흐름: 영수증 접수 → AI 판독 → 후보 확인(버튼) → 장부 저장, 선지불/입금완료 처리
import {
  CATEGORIES, classify, toHKD, isPrepaidText, isPaidText, prepaidRef, paidRef,
  findPrepaidRow, detailsText, fmtMoney,
} from './rules.js';
import { SUPPORTED_MIME } from './extract.js';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const HELP = [
  "O'rm 영수증 비서 사용법",
  '1) 영수증 사진이나 PDF를 보내 주세요. 회사 대신 개인 돈으로 냈으면 캡션에 "선지불"이라고 적어 주세요.',
  '2) 비서가 장부 후보를 보내면 [저장]을 누르세요. 틀린 곳은 답장으로 알려 주세요 (예: "총액 1,200", "날짜 10/20").',
  '3) 선지불 건을 입금했으면 "영수증번호 입금완료"라고 보내 주세요 (예: "R261022-K7Q 입금완료").',
].join('\n');

export function createBot({ wa, extract, sheets, allowed = [], defaultCnyRate = 1.09, log = console }) {
  const drafts = new Map(); // draftId -> draft
  const latest = new Map(); // phone -> draftId
  const seen = new Map();   // messageId -> time (중복 웹훅 방지)
  const queues = new Map(); // phone -> Promise (발신자별 순차 처리)
  const prepaidHint = new Map(); // phone -> time ("선지불"을 사진보다 먼저 보낸 경우)

  const newId = () => {
    const d = new Date();
    const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
    return `R${ymd}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  };
  function gc() {
    const now = Date.now();
    for (const [id, d] of drafts) if (now - d.createdAt > DRAFT_TTL_MS) { drafts.delete(id); if (latest.get(d.phone) === id) latest.delete(d.phone); }
    for (const [id, t] of seen) if (now - t > DRAFT_TTL_MS) seen.delete(id);
  }

  async function cnyRate() {
    try { const v = Number((await sheets.getConfig()).CNY_HKD); return v > 0 ? v : defaultCnyRate; } catch { return defaultCnyRate; }
  }
  async function vendors() { try { return await sheets.getVendors(); } catch (e) { log.warn?.('vendors', e.message); return []; } }

  // ---------- 후보 만들기 ----------
  async function runExtraction(d) {
    const vs = await vendors();
    const out = await extract({ media: d.media, sender: d.name, message: d.message, answers: d.answers, vendors: vs });
    d.ai = out;
    if (out.readable === false) { d.waiting = true; return; }
    d.waiting = false;
    const items = Array.isArray(out.items) ? out.items : [];
    const currency = String(out.currency || 'HKD').toUpperCase();
    const total = Number(out.total) || 0;
    const { rate, hkd } = toHKD(total, currency, await cnyRate());
    const cls = d.manualCategory ? { category: d.manualCategory, reason: '담당자가 직접 선택', needsReview: false } : classify(items, out.vendor, vs);
    Object.assign(d, {
      date: out.date || '', vendor: out.vendor || '', receiptNo: out.receipt_no || '', items, details: detailsText(items),
      currency, amount: total, rate, hkd, category: cls.category, reason: cls.reason, needsReview: cls.needsReview,
      payment: out.payment_method || '', notes: out.notes || '',
    });
    if (!d.firstSnapshot) d.firstSnapshot = snapshot(d);
  }
  const snapshot = (d) => ({ 날짜: d.date, 거래처: d.vendor, 영수증번호: d.receiptNo, 상세내역: d.details, 통화: d.currency, 원금액: d.amount, 분류: d.category });

  function summary(d) {
    const money = d.currency === 'HKD'
      ? `HKD ${fmtMoney(d.amount)}`
      : `${d.currency} ${fmtMoney(d.amount)} → ${d.hkd === null ? 'HKD 환산 불가 (환율 기준 없음)' : `HKD ${fmtMoney(d.hkd)} (@${d.rate}, 임시 환율)`}`;
    return [
      `장부 후보 ${d.id}`,
      `날짜: ${d.date || '-'}`,
      `거래처: ${d.vendor || '-'}`,
      `번호: ${d.receiptNo || '-'}`,
      `내역: ${d.details || '-'}`,
      `금액: ${money}`,
      `분류: ${CATEGORIES[d.category] || '미정 — [분류 변경]에서 선택'}`,
      `  근거: ${d.reason}`,
      d.prepaid ? `REF: ${prepaidRef(d.name)}` : null,
      d.notes ? `메모: ${d.notes}` : null,
      '',
      '틀린 곳은 답장으로 알려 주세요.',
    ].filter((x) => x !== null).join('\n');
  }

  async function present(d) {
    if (d.waiting) {
      await wa.sendText(d.phone, `${d.ai?.question || '영수증을 읽기 어려워요. 날짜·거래처·총액을 알려 주시겠어요?'}\n(답장해 주시면 반영해서 다시 읽을게요. 그만두려면 "취소")`);
      return;
    }
    await wa.sendButtons(d.phone, summary(d), [
      { id: `save:${d.id}`, title: '저장' },
      { id: `cat:${d.id}`, title: '분류 변경' },
      { id: `drop:${d.id}`, title: '버리기' },
    ]);
  }

  async function startDraft(msg) {
    if (!SUPPORTED_MIME.includes((msg.mimeType || '').split(';')[0])) {
      await wa.sendText(msg.from, '사진(JPG/PNG) 또는 PDF로 보내 주세요.');
      return;
    }
    const d = {
      id: newId(), phone: msg.from, name: msg.name, message: msg.text || '', answers: [],
      prepaid: isPrepaidText(msg.text) || (Date.now() - (prepaidHint.get(msg.from) || 0) < 5 * 60 * 1000),
      createdAt: Date.now(), sourceMessageId: msg.id,
    };
    prepaidHint.delete(msg.from);
    d.media = await wa.downloadMedia(msg.mediaId);
    drafts.set(d.id, d); latest.set(d.phone, d.id);
    await wa.sendText(d.phone, '영수증을 받았어요. 읽는 중이에요…');
    await runExtraction(d);
    await present(d);
  }

  // ---------- 저장 ----------
  async function save(d, phone) {
    if (!d.category) {
      await askCategory(d, '분류를 먼저 골라 주세요.');
      return;
    }
    const final = snapshot(d);
    const changed = Object.keys(final).filter((k) => String(final[k] ?? '') !== String(d.firstSnapshot?.[k] ?? ''));
    await sheets.appendLedger({
      ID: d.id, 날짜: d.date, 거래처: d.vendor, 영수증번호: d.receiptNo, 상세내역: d.details, 통화: d.currency,
      원금액: d.amount, 환율: d.rate ?? '', HKD: d.hkd ?? '', 분류: CATEGORIES[d.category], 분류근거: d.reason,
      결제수단: d.payment, REF: d.prepaid ? prepaidRef(d.name) : '', 올린사람: d.name, 올린사람번호: d.phone,
      원메시지: [d.message, ...d.answers].filter(Boolean).join(' / '), AI대비수정: changed.join(', ') || '없음',
      등록시각: new Date().toISOString(),
    });
    drafts.delete(d.id); if (latest.get(phone) === d.id) latest.delete(phone);
    await wa.sendText(phone, `장부에 저장했어요 (${d.id}).${d.prepaid ? `\n선지불 건이에요. 입금 후 "${d.receiptNo || d.id} 입금완료"라고 보내 주세요.` : ''}`);
  }

  async function askCategory(d, text) {
    await wa.sendList(d.phone, text, '분류 선택', Object.entries(CATEGORIES).map(([k, label]) => ({ id: `set:${d.id}:${k}`, title: label })));
  }

  // ---------- 입금완료 (B01) ----------
  async function handlePaid(msg) {
    const rows = await sheets.listLedger();
    const { hit, open } = findPrepaidRow(rows, msg.text);
    if (!hit) {
      const list = open.slice(-5).map((r) => `- ${r.receiptNo || r.id} (${r.vendor}, HKD ${r.hkd})`).join('\n');
      await wa.sendText(msg.from, open.length
        ? `어느 영수증인지 찾지 못했어요. 미입금 선지불 건:\n${list}\n번호와 함께 "입금완료"를 보내 주세요.`
        : '미입금 상태인 선지불 건이 없어요.');
      return;
    }
    const prepaidBy = (hit.ref.split(' 선지불')[0] || hit.uploader || '?').trim();
    const ref = paidRef(prepaidBy);
    await sheets.markPaid(hit.rowNumber, { ref, paidAt: new Date().toISOString(), reportedBy: msg.name || msg.from });
    await wa.sendText(msg.from, `${hit.receiptNo || hit.id} (${hit.vendor}, HKD ${hit.hkd}) REF를 갱신했어요.\n→ ${ref}`);
  }

  // ---------- 버튼/목록 답장 ----------
  async function handleReply(msg) {
    const [action, id, extra] = String(msg.replyId).split(':');
    const d = drafts.get(id);
    if (!d || d.phone !== msg.from) { await wa.sendText(msg.from, '이 후보는 만료됐거나 이미 처리됐어요. 영수증을 다시 보내 주세요.'); return; }
    if (action === 'save') return save(d, msg.from);
    if (action === 'cat') return askCategory(d, `${d.id} 분류를 골라 주세요.`);
    if (action === 'set' && CATEGORIES[extra]) {
      d.category = extra; d.manualCategory = extra; d.reason = '담당자가 직접 선택'; d.needsReview = false;
      return present(d);
    }
    if (action === 'drop') {
      drafts.delete(id); if (latest.get(msg.from) === id) latest.delete(msg.from);
      return wa.sendText(msg.from, `${id} 후보를 버렸어요.`);
    }
  }

  // ---------- 텍스트 ----------
  async function handleText(msg) {
    const t = (msg.text || '').trim();
    if (/^(도움말|help|\?|사용법)$/i.test(t)) return wa.sendText(msg.from, HELP);
    if (isPaidText(t)) return handlePaid(msg);
    const d = drafts.get(latest.get(msg.from));
    if (d) {
      if (/^취소$/.test(t)) { drafts.delete(d.id); latest.delete(msg.from); return wa.sendText(msg.from, `${d.id} 후보를 취소했어요.`); }
      if (isPrepaidText(t) && t.length <= 12) { d.prepaid = true; return present(d); } // 사진 뒤에 따로 보낸 "선지불"
      // 그 외 답장 = 질문에 대한 답 또는 정정 → 반영해서 다시 판독
      d.answers.push(t);
      if (isPrepaidText(t)) d.prepaid = true;
      await wa.sendText(msg.from, '반영해서 다시 읽는 중이에요…');
      await runExtraction(d);
      return present(d);
    }
    if (isPrepaidText(t)) { // 사진보다 "선지불"을 먼저 보낸 경우: 5분 안에 오는 영수증에 적용
      prepaidHint.set(msg.from, Date.now());
      return wa.sendText(msg.from, '선지불로 표시할게요. 영수증 사진을 보내 주세요.');
    }
    return wa.sendText(msg.from, `영수증 사진이나 PDF를 보내 주세요.\n사용법이 궁금하면 "도움말"이라고 보내 주세요.`);
  }

  async function process(msg) {
    if (allowed.length && !allowed.includes(msg.from)) {
      log.warn?.('허용되지 않은 번호', msg.from);
      return;
    }
    wa.markRead(msg.id);
    try {
      if (msg.replyId) return await handleReply(msg);
      if (msg.mediaId) return isPaidText(msg.text) ? await handlePaid(msg) : await startDraft(msg);
      if (msg.type === 'text' || msg.type === 'button') return await handleText(msg);
      await wa.sendText(msg.from, '사진, PDF, 글자 메시지만 처리할 수 있어요. 음성 메시지는 아직 지원하지 않아요.');
    } catch (e) {
      log.error?.('처리 실패', msg.id, e);
      await wa.sendText(msg.from, '처리 중 문제가 생겼어요. 잠시 후 다시 보내 주세요.').catch(() => {});
    }
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

  return { handle, _drafts: drafts };
}

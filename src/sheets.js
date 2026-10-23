// Google Sheets 저장소
// 장부 탭은 실제 '오름 통합 회계 시트'와 같은 이름·같은 A~L 열 구성(09_장부 필드 정의)을 쓴다.
//   Purchase_Food / Purchase_Drink / Expenses (SG&A)
// 보조 탭: Staff(직원·승인자), Vendors(거래처 기준정보), Config(설정), AI_Log(처리 기록), _Pending(승인 대기 보관)
import { google } from 'googleapis';
import { CATEGORIES } from './rules.js';

export const LEDGER_HEADERS = [
  'No.', '인보이스 PDF_파일명/폴더 (File name)', '영수증번호 (Inv No.)', '영수증 날짜 (Inv Date)', '업체명 (Company)',
  '통화 (Currency)', '상세내역 (Description)', '해당 통화 금액 (Amount)', 'HKD 반영 금액 (Amount) HKD',
  '지급일 (결제일) (Payment date)', '사용된 계좌 (Payment account)', 'REF',
];
export const LOG_HEADERS = [
  '처리ID', '상태', '시트', 'No.', '영수증번호', '업체', '통화', '금액', 'HKD', '분류 근거', '올린사람', '올린사람번호',
  '승인자', '원메시지ID', '미디어ID', '메시지·정정', 'AI 원본', 'AI대비수정', '환율 근거', '생성시각', '처리시각',
];
const LEDGER_TABS = Object.values(CATEGORIES);
const q = (tab) => `'${tab.replace(/'/g, "''")}'`;

const TAB_DEFAULTS = {
  Staff: [
    ['전화번호 (국가번호 포함, + 없이)', '장부 표기 이름 (REF에 들어감)', '역할 (직원/회계/디렉터)', '메모'],
  ],
  Vendors: [
    ['거래처', '별칭 (쉼표로 구분)', '취급 특성 (Food/Drink/Mixed/Other)'],
    ['Classic Fine Foods', 'CLASSIC FINE FOODS, CFF, Classic Fine Foods (HK) Ltd', 'Food'],
  ],
  Config: [
    ['키', '값', '설명'],
    ['CNY_HKD_FALLBACK', '', '네이버 환율 자동조회가 실패할 때만 쓰는 임시 환율(1 CNY당 HKD). 비워 두면 승인자에게 확인 요청'],
    ['FILE_LABEL', '1.오름 통합 영수증/인보이스 파일 모음 => 오름 {year} 매입 인보이스 모음', '장부 B열(파일명/폴더)에 넣을 값. {year}는 올해'],
    ['REF_PREPAID', '{name} 선지불, 추후 입금 해야함', '선지불 영수증 저장 시 REF (D11)'],
    ['REF_PAID', '{name} 대표 선지불, 추후 입금완료', '입금완료 반영 시 REF (D11)'],
  ],
  AI_Log: [LOG_HEADERS],
  _Pending: [['처리ID', '데이터(JSON) — 서버 재시작 후 승인 대기 건 복구용. 직접 수정하지 마세요']],
};

export function createSheetsStore({ sheetId, serviceAccountJson, cacheMs = 60_000 }) {
  const creds = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api = google.sheets({ version: 'v4', auth }).spreadsheets;
  const cache = {};
  async function cached(key, fn) {
    const c = cache[key];
    if (c && Date.now() - c.at < cacheMs) return c.v;
    const v = await fn(); cache[key] = { at: Date.now(), v }; return v;
  }
  const get = async (range) => (await api.values.get({ spreadsheetId: sheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || [];
  let tabIds = {};
  async function loadMeta() {
    const meta = await api.get({ spreadsheetId: sheetId });
    tabIds = Object.fromEntries(meta.data.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    return tabIds;
  }

  /** 필요한 탭이 없으면 머리글과 함께 만든다. 이미 있는 탭은 건드리지 않는다. */
  async function ensureTabs() {
    await loadMeta();
    const want = { ...Object.fromEntries(LEDGER_TABS.map((t) => [t, [LEDGER_HEADERS]])), ...TAB_DEFAULTS };
    const add = Object.keys(want).filter((t) => !(t in tabIds));
    if (!add.length) return [];
    await api.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: add.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) } });
    for (const t of add) await api.values.update({ spreadsheetId: sheetId, range: `${q(t)}!A1`, valueInputOption: 'RAW', requestBody: { values: want[t] } });
    await loadMeta();
    return add;
  }

  /** 장부 탭의 데이터 행: A열이 '#'로 시작하는 행 ('Sample' 양식 예시 이전까지) */
  async function readTab(tab) {
    const rows = await get(`${q(tab)}!A1:L`);
    const out = [];
    let lastDataRow = 0;
    let sampleAt = 0;
    rows.forEach((r, i) => {
      const a = String(r[0] ?? '').trim();
      if (sampleAt) return;
      if (/^sample/i.test(a)) { sampleAt = i + 1; return; }
      if (!a.startsWith('#')) return;
      lastDataRow = i + 1;
      out.push({
        tab, rowNumber: i + 1, no: a, file: r[1] ?? '', receiptNo: String(r[2] ?? ''), date: r[3] ?? '', vendor: String(r[4] ?? ''),
        currency: String(r[5] ?? '').trim(), details: r[6] ?? '', amount: r[7] ?? '', hkd: r[8] ?? '', payDate: r[9] ?? '', account: r[10] ?? '', ref: String(r[11] ?? ''),
      });
    });
    if (!lastDataRow) {
      // 데이터가 아직 없으면 머리글 바로 아래. 실제 장부처럼 머리글이 2줄(A칸 빈 둘째 줄)이면 그 아래.
      const h = rows.findIndex((r) => String(r[0] ?? '').trim() === 'No.') + 1 || 1;
      const second = rows[h]; // 0-based index h = 다음 줄
      lastDataRow = second && !String(second[0] ?? '').trim() && String(second[1] ?? '').trim() ? h + 1 : h;
    }
    return { rows: out, lastDataRow, hasBelow: !!sampleAt, colA: rows.map((r) => r[0]) };
  }

  return {
    api, sheetId, ensureTabs,

    getStaff: () => cached('staff', async () =>
      (await get('Staff!A2:D')).filter((r) => r[0]).map((r) => ({
        phone: String(r[0]).replace(/[^\d]/g, ''), name: String(r[1] || '').trim(), role: String(r[2] || '').trim(),
      }))),

    getVendors: () => cached('vendors', async () =>
      (await get('Vendors!A2:C')).filter((r) => r[0]).map((r) => ({
        name: String(r[0]).trim(), aliases: String(r[1] || '').split(',').map((s) => s.trim()).filter(Boolean), type: String(r[2] || '').trim(),
      }))),

    getConfig: () => cached('config', async () =>
      Object.fromEntries((await get('Config!A2:B')).filter((r) => r[0]).map((r) => [String(r[0]).trim(), r[1] ?? '']))),

    /** 세 장부 탭 전체 행 */
    async listLedger() {
      const all = [];
      for (const t of LEDGER_TABS) all.push(...(await readTab(t)).rows);
      return all;
    },

    /** 그 탭 A열 값 (번호 계산용) */
    async columnA(tab) { return (await readTab(tab)).colA; },

    /**
     * 장부에 1행 추가 — 마지막 데이터 행 바로 아래. 아래에 양식 예시(Sample)가 있으면 행을 끼워 넣는다.
     * values: 12칸 배열(A~L). @returns rowNumber
     */
    async insertLedgerRow(tab, values) {
      if (!(tab in tabIds)) await loadMeta();
      const { lastDataRow, hasBelow } = await readTab(tab);
      const target = lastDataRow + 1;
      if (hasBelow) {
        await api.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: [{ insertDimension: { range: { sheetId: tabIds[tab], dimension: 'ROWS', startIndex: target - 1, endIndex: target }, inheritFromBefore: true } }] } });
      }
      // RAW: 영수증 글자가 수식(=...)으로 실행되지 않도록
      await api.values.update({ spreadsheetId: sheetId, range: `${q(tab)}!A${target}:L${target}`, valueInputOption: 'RAW', requestBody: { values: [values] } });
      return target;
    },

    /** D09 기존 행 수정: A열(번호)은 유지하고 B~L만 덮어쓴다 */
    async updateLedgerRow(tab, rowNumber, valuesBtoL) {
      await api.values.update({ spreadsheetId: sheetId, range: `${q(tab)}!B${rowNumber}:L${rowNumber}`, valueInputOption: 'RAW', requestBody: { values: [valuesBtoL] } });
    },

    async updateRef(tab, rowNumber, ref) {
      await api.values.update({ spreadsheetId: sheetId, range: `${q(tab)}!L${rowNumber}`, valueInputOption: 'RAW', requestBody: { values: [[ref]] } });
    },

    async appendLog(obj) {
      const values = [LOG_HEADERS.map((h) => {
        const v = obj[h];
        return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
      })];
      await api.values.append({ spreadsheetId: sheetId, range: 'AI_Log!A:U', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
    },

    // ---- 승인 대기 보관 (서버 재시작 대비) ----
    async loadPending() {
      return (await get('_Pending!A2:B')).filter((r) => r[0] && r[1]).map((r) => { try { return JSON.parse(r[1]); } catch { return null; } }).filter(Boolean);
    },
    async savePending(list) {
      await api.values.clear({ spreadsheetId: sheetId, range: '_Pending!A2:B' });
      if (list.length) await api.values.update({ spreadsheetId: sheetId, range: '_Pending!A2', valueInputOption: 'RAW', requestBody: { values: list.map((d) => [d.id, JSON.stringify(d)]) } });
    },
  };
}

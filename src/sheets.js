// Google Sheets 장부 저장소. 탭: Ledger(장부), Vendors(거래처 기준정보), Config(설정)
import { google } from 'googleapis';

// ⚠️ 임시 열 구성 — '09_장부 필드 정의' 탭에 맞춰 조정 필요
export const LEDGER_HEADERS = [
  'ID', '날짜', '거래처', '영수증번호', '상세내역', '통화', '원금액', '환율', 'HKD', '분류', '분류근거',
  '결제수단', 'REF', '올린사람', '올린사람번호', '원메시지', 'AI대비수정', '등록시각', '입금완료시각', '입금보고자',
];
const COL = Object.fromEntries(LEDGER_HEADERS.map((h, i) => [h, String.fromCharCode(65 + i)]));
const LAST = COL[LEDGER_HEADERS.at(-1)];

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
  const get = async (range) => (await api.values.get({ spreadsheetId: sheetId, range })).data.values || [];

  /** Ledger / Vendors / Config 탭이 없으면 머리글과 함께 만든다 (이미 있으면 그대로). */
  async function ensureTabs() {
    const tabs = {
      Ledger: [LEDGER_HEADERS],
      Vendors: [['거래처', '주 취급 품목 (Food/Drink/Mixed/Other)'], ['Classic Fine Foods', 'Food']],
      Config: [['키', '값', '설명'], ['CNY_HKD', 1.09, '1 CNY당 HKD — 임시값, D12·D13 확정 후 수정']],
    };
    const meta = await api.get({ spreadsheetId: sheetId });
    const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
    const add = Object.keys(tabs).filter((t) => !existing.has(t));
    if (!add.length) return [];
    await api.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: add.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) } });
    for (const t of add) await api.values.update({ spreadsheetId: sheetId, range: `${t}!A1`, valueInputOption: 'RAW', requestBody: { values: tabs[t] } });
    return add;
  }

  return {
    api, sheetId, ensureTabs,
    getVendors: () => cached('vendors', async () =>
      (await get('Vendors!A2:B')).filter((r) => r[0]).map((r) => ({ name: String(r[0]).trim(), type: String(r[1] || '').trim() }))),

    getConfig: () => cached('config', async () =>
      Object.fromEntries((await get('Config!A2:B')).filter((r) => r[0]).map((r) => [String(r[0]).trim(), r[1]]))),

    async appendLedger(row) {
      const values = [LEDGER_HEADERS.map((h) => (row[h] ?? ''))];
      // RAW: 영수증 글자가 수식(=...)으로 실행되지 않도록
      await api.values.append({ spreadsheetId: sheetId, range: `Ledger!A:${LAST}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
    },

    /** 장부 전체 → [{rowNumber, id, receiptNo, ref, vendor, hkd, uploader}] */
    async listLedger() {
      const rows = await get(`Ledger!A2:${LAST}`);
      const idx = (h) => LEDGER_HEADERS.indexOf(h);
      return rows.map((r, i) => ({
        rowNumber: i + 2, id: r[idx('ID')] || '', receiptNo: r[idx('영수증번호')] || '', ref: r[idx('REF')] || '',
        vendor: r[idx('거래처')] || '', hkd: r[idx('HKD')] || '', uploader: r[idx('올린사람')] || '',
      }));
    },

    async markPaid(rowNumber, { ref, paidAt, reportedBy }) {
      await api.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `Ledger!${COL.REF}${rowNumber}`, values: [[ref]] },
            { range: `Ledger!${COL['입금완료시각']}${rowNumber}:${COL['입금보고자']}${rowNumber}`, values: [[paidAt, reportedBy]] },
          ],
        },
      });
    },
  };
}

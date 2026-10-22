// 장부 스프레드시트에 Ledger / Vendors / Config 탭과 머리글을 만든다. (서버도 시작할 때 자동으로 실행함)
// 사용: GOOGLE_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='{...}' npm run setup-sheet
import { createSheetsStore } from '../src/sheets.js';

const { GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;
if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_JSON) { console.error('GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON 필요'); process.exit(1); }
const added = await createSheetsStore({ sheetId: GOOGLE_SHEET_ID, serviceAccountJson: GOOGLE_SERVICE_ACCOUNT_JSON }).ensureTabs();
console.log(added.length ? `만든 탭: ${added.join(', ')}` : '모든 탭이 이미 있어요.');

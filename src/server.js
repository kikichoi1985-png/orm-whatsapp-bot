import express from 'express';
import { createWhatsApp, verifySignature, parseWebhook } from './whatsapp.js';
import { createExtractor } from './extract.js';
import { createSheetsStore } from './sheets.js';
import { createBot } from './flow.js';

const env = process.env;
for (const k of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON']) {
  if (!env[k]) { console.error(`환경변수 ${k}가 비어 있어요. .env.example을 참고하세요.`); process.exit(1); }
}
if (!env.WHATSAPP_APP_SECRET) console.warn('WHATSAPP_APP_SECRET이 없어 웹훅 서명 검증을 건너뜁니다 (운영 전 반드시 설정).');

const wa = createWhatsApp({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, version: env.GRAPH_API_VERSION || 'v23.0' });
const extract = createExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || 'claude-sonnet-5-5' });
const sheets = createSheetsStore({ sheetId: env.GOOGLE_SHEET_ID, serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON });
const bot = createBot({
  wa, extract, sheets,
  allowed: (env.ALLOWED_NUMBERS || '').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean),
  defaultCnyRate: Number(env.DEFAULT_CNY_HKD) || 1.09,
});

const app = express();
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send("O'rm 영수증 비서 실행 중"));

// Meta 웹훅 확인
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// 메시지 수신 — Meta는 빠른 200 응답을 기대하므로 먼저 응답하고 처리
app.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) return res.sendStatus(401);
  res.sendStatus(200);
  for (const msg of parseWebhook(req.body)) bot.handle(msg).catch((e) => console.error(e));
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`listening on :${port}`));

sheets.ensureTabs()
  .then((added) => console.log(added.length ? `장부 시트에 탭을 만들었어요: ${added.join(', ')}` : '장부 시트 확인 완료'))
  .catch((e) => console.error('장부 시트에 접근하지 못했어요. 시트를 서비스 계정 이메일과 "편집자"로 공유했는지 확인하세요.', e.message));

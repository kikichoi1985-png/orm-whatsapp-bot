import express from 'express';
import { createWhatsApp, verifySignature, parseWebhook } from './whatsapp.js';
import { createExtractor } from './extract.js';
import { createSheetsStore } from './sheets.js';
import { createBot } from './flow.js';

const env = process.env;
const missing = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON'].filter((k) => !env[k]);
if (missing.length) console.warn(`[설정 대기] 비어 있는 환경변수: ${missing.join(', ')} — 웹훅 확인과 수신 로그만 동작하고, 영수증 처리는 모두 채워지면 켜져요.`);
if (!env.WHATSAPP_APP_SECRET) console.warn('WHATSAPP_APP_SECRET이 없어 웹훅 서명 검증을 건너뜁니다 (운영 전 반드시 설정).');

let bot = null;
let sheets = null;
if (!missing.length) {
  const wa = createWhatsApp({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, version: env.GRAPH_API_VERSION || 'v25.0' });
  const extract = createExtractor({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || 'claude-sonnet-5-5' });
  sheets = createSheetsStore({ sheetId: env.GOOGLE_SHEET_ID, serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON });
  bot = createBot({
    wa, extract, sheets,
    allowed: (env.ALLOWED_NUMBERS || '').split(',').map((s) => s.trim().replace(/^\+/, '')).filter(Boolean),
    defaultCnyRate: Number(env.DEFAULT_CNY_HKD) || 1.09,
  });
}

const app = express();
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send(bot ? "O'rm 영수증 비서 실행 중" : `O'rm 영수증 비서 — 설정 대기 (${missing.join(', ')})`));

app.get('/healthz', (_req, res) => res.send('ok'));

// Meta 웹훅 확인
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && req.query['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// 메시지 수신 — Meta는 빠른 200 응답을 기대하므로 먼저 응답하고 처리
app.post('/webhook', (req, res) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) {
    console.warn('[웹훅] 서명 불일치 — WHATSAPP_APP_SECRET이 웹훅을 보낸 앱의 시크릿과 같은지 확인하세요.');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  // 발송 결과(sent/delivered/read/failed) 로그 — 실패 원인 코드는 여기로만 옴
  for (const e of req.body?.entry || []) for (const c of e.changes || []) for (const s of c.value?.statuses || []) {
    const err = (s.errors || []).map((x) => `${x.code} ${x.title}${x.error_data?.details ? ' — ' + x.error_data.details : ''}`).join('; ');
    console[s.status === 'failed' ? 'error' : 'log'](`[발송상태] ${s.recipient_id} ${s.status}${err ? ' | ' + err : ''}`);
  }
  for (const msg of parseWebhook(req.body)) {
    console.log(`[수신] ${msg.from} ${msg.type}${msg.text ? ' "' + String(msg.text).slice(0, 40) + '"' : ''}`);
    if (bot) bot.handle(msg).catch((e) => console.error(e));
  }
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => console.log(`listening on :${port}${bot ? '' : ' (설정 대기 모드)'}`));

sheets?.ensureTabs()
  .then((added) => console.log(added.length ? `장부 시트에 탭을 만들었어요: ${added.join(', ')}` : '장부 시트 확인 완료'))
  .catch((e) => console.error('장부 시트에 접근하지 못했어요. 시트를 서비스 계정 이메일과 "편집자"로 공유했는지 확인하세요.', e.message));

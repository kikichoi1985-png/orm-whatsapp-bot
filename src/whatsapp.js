// WhatsApp Cloud API 클라이언트 (Graph API)
import crypto from 'node:crypto';

export function createWhatsApp({ token, phoneNumberId, version = 'v25.0', fetchImpl = fetch }) {
  const base = `https://graph.facebook.com/${version}`;
  const auth = { Authorization: `Bearer ${token}` };

  async function post(payload) {
    const res = await fetchImpl(`${base}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`WhatsApp 전송 실패 ${res.status}: ${body}`);
      try { err.code = JSON.parse(body)?.error?.code; } catch { /* 본문이 JSON이 아님 */ }
      throw err;
    }
    return res.json();
  }
  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  return {
    sendText: (to, body) => post({ to, type: 'text', text: { body: clip(body, 4096), preview_url: false } }),

    /** 답장 버튼 (최대 3개, 제목 20자) */
    sendButtons: (to, body, buttons) => post({
      to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: clip(body, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })) },
      },
    }),

    /** 목록 메시지 (행 제목 24자) */
    sendList: (to, body, buttonText, rows) => post({
      to, type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: clip(body, 1024) },
        action: { button: clip(buttonText, 20), sections: [{ title: '선택', rows: rows.map((r) => ({ id: r.id, title: clip(r.title, 24), description: r.description ? clip(r.description, 72) : undefined })) }] },
      },
    }),

    /** 승인된 템플릿 메시지 (24시간 대화창 밖에서 먼저 연락할 때) */
    sendTemplate: (to, name, lang = 'ko', bodyParams = []) => post({
      to, type: 'template',
      template: { name, language: { code: lang }, ...(bodyParams.length ? { components: [{ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) }] } : {}) },
    }),

    markRead: (messageId) => post({ status: 'read', message_id: messageId }).catch(() => {}),

    /** 미디어 다운로드 → {base64, mimeType} */
    async downloadMedia(mediaId) {
      const meta = await fetchImpl(`${base}/${mediaId}`, { headers: auth });
      if (!meta.ok) throw new Error(`미디어 조회 실패 ${meta.status}`);
      const { url, mime_type } = await meta.json();
      const file = await fetchImpl(url, { headers: auth });
      if (!file.ok) throw new Error(`미디어 다운로드 실패 ${file.status}`);
      const buf = Buffer.from(await file.arrayBuffer());
      return { base64: buf.toString('base64'), mimeType: (mime_type || '').split(';')[0].trim() };
    },
  };
}

/** X-Hub-Signature-256 검증 */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return true; // 설정 안 했으면 검증 생략 (개발용)
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 웹훅 본문에서 처리할 메시지들을 평탄화 */
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of v.messages || []) {
        const msg = { id: m.id, from: m.from, name: names[m.from] || '', type: m.type, timestamp: Number(m.timestamp) * 1000 };
        if (m.context?.id) msg.contextId = m.context.id; // 특정 메시지에 '답장'한 경우 그 원래 메시지 ID
        if (m.type === 'text') msg.text = m.text?.body || '';
        else if (m.type === 'image') Object.assign(msg, { mediaId: m.image?.id, mimeType: m.image?.mime_type, text: m.image?.caption || '' });
        else if (m.type === 'document') Object.assign(msg, { mediaId: m.document?.id, mimeType: m.document?.mime_type, text: m.document?.caption || '', filename: m.document?.filename });
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply || m.interactive?.list_reply;
          msg.replyId = r?.id; msg.text = r?.title || '';
        } else if (m.type === 'button') msg.text = m.button?.text || '';
        out.push(msg);
      }
    }
  }
  return out;
}

// Google Drive 저장소 — 승인된 영수증 원본을 장부 탭별 폴더(공유 드라이브)에 저장
// 서비스 계정은 개인 '내 드라이브'에 파일을 만들 수 없으므로 공유 드라이브 폴더를 쓴다(supportsAllDrives).
import { Readable } from 'node:stream';
import { google } from 'googleapis';

const EXT = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const extOf = (mimeType) => EXT[String(mimeType || '').split(';')[0].trim().toLowerCase()] || 'bin';

/**
 * folders: { Expenses, Purchase_Food, Purchase_Drink } → 폴더 ID
 * upload(category, name, files) — files: [{ base64, mimeType }]
 *  1장: 폴더에 "name.ext" / 여러 장: "name" 폴더를 만들고 "name.ext", "name 2.ext" …
 */
export function createDriveStore({ serviceAccountJson, folders = {} }) {
  const creds = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/drive'] });
  const api = google.drive({ version: 'v3', auth });
  const common = { supportsAllDrives: true, fields: 'id, name, webViewLink' };

  async function createFile(parent, name, f) {
    const res = await api.files.create({
      ...common,
      requestBody: { name, parents: [parent] },
      media: { mimeType: f.mimeType, body: Readable.from(Buffer.from(f.base64, 'base64')) },
    });
    return res.data;
  }

  return {
    hasFolder: (category) => !!folders[category],
    async upload(category, name, files) {
      const parent = folders[category];
      if (!parent) return null;
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
      if (!list.length) return null;
      if (list.length === 1) {
        const f = await createFile(parent, `${name}.${extOf(list[0].mimeType)}`, list[0]);
        return { name: f.name, id: f.id, link: f.webViewLink, count: 1 };
      }
      const dir = (await api.files.create({ ...common, requestBody: { name, parents: [parent], mimeType: 'application/vnd.google-apps.folder' } })).data;
      for (let i = 0; i < list.length; i++) {
        await createFile(dir.id, `${name}${i ? ` ${i + 1}` : ''}.${extOf(list[i].mimeType)}`, list[i]);
      }
      return { name: dir.name, id: dir.id, link: dir.webViewLink, count: list.length };
    },
  };
}

/**
 * 공유 드라이브 없이 '내 드라이브' 폴더에 저장할 때: 폴더 소유자(또는 편집자) 계정으로 배포한
 * Google Apps Script 웹 앱에 파일을 보낸다. 파일 소유자는 스크립트를 배포한 계정이 된다.
 */
export function createScriptDriveStore({ url, secret, folders = {}, fetchImpl = fetch }) {
  return {
    hasFolder: (category) => !!folders[category],
    async upload(category, name, files) {
      const folderId = folders[category];
      if (!folderId) return null;
      const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
        .map((f) => ({ base64: f.base64, mimeType: f.mimeType, ext: extOf(f.mimeType) }));
      if (!list.length) return null;
      const res = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
        body: JSON.stringify({ secret, folderId, name, files: list }),
      });
      const text = await res.text();
      let out;
      try { out = JSON.parse(text); } catch { throw new Error(`드라이브 스크립트 응답 오류 (HTTP ${res.status})`); }
      if (!out.ok) throw new Error(out.error || '드라이브 스크립트 실패');
      return { name: out.name, id: out.id, link: out.url, count: list.length };
    },
  };
}

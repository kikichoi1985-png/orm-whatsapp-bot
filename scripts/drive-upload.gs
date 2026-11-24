/**
 * O'rm 영수증 비서 — 드라이브 업로드 웹 앱 (Google Apps Script)
 * 폴더 소유자 계정(management@orm-hk.com)으로 배포한다. 비서(Render)가 승인된 영수증 파일을 보내면
 * 지정한 폴더에 규칙대로 저장한다. 사진이 여러 장이면 같은 이름의 폴더를 만들어 넣는다.
 *
 * 설정: 프로젝트 설정(⚙) → 스크립트 속성 → UPLOAD_SECRET = (Render의 DRIVE_SCRIPT_SECRET과 같은 값)
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('UPLOAD_SECRET');
    if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
    var parent = DriveApp.getFolderById(body.folderId);
    var files = body.files || [];
    if (!files.length) return json_({ ok: false, error: 'no files' });
    var blobOf = function (f, name) {
      return Utilities.newBlob(Utilities.base64Decode(f.base64), f.mimeType, name + '.' + (f.ext || 'bin'));
    };
    if (files.length === 1) {
      var file = parent.createFile(blobOf(files[0], body.name));
      return json_({ ok: true, id: file.getId(), name: file.getName(), url: file.getUrl() });
    }
    var dir = parent.createFolder(body.name);
    for (var i = 0; i < files.length; i++) dir.createFile(blobOf(files[i], body.name + (i ? ' ' + (i + 1) : '')));
    return json_({ ok: true, id: dir.getId(), name: dir.getName(), url: dir.getUrl() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

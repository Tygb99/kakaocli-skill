// 카톡 채팅 창(이미 열린 창)에 글을 넣고 전송한다. 사용자의 마우스·키보드를 쓰지 않는다(System Events 접근성만).
// 창·입력칸·버튼 이름(KakaoTalk, 메시지 입력, 전송)은 한국어 UI에서 확인한 값이다.
// 사용: osascript -l JavaScript kakao-send-ui.js <창 제목> <글 파일> <set|send|clear>
//  set   : 입력칸이 비어 있을 때만 글을 넣고 그대로 둔다(확인용)
//  send  : 입력칸이 비어 있을 때만 글을 넣고 전송 버튼을 누른다
//  clear : 입력칸을 비운다
// 출력: 한 줄 JSON {ok, step, ...}
function run(argv) {
  const [title, file, mode] = argv;
  const se = Application('System Events');
  const p = se.processes.byName('KakaoTalk');
  if (!p.exists()) return JSON.stringify({ ok: false, step: 'NO_APP' });
  const w = p.windows.byName(title);
  if (!w.exists()) return JSON.stringify({ ok: false, step: 'WINDOW_NOT_OPEN', title });
  let box = null;
  for (const sa of w.scrollAreas()) {
    for (const ta of sa.textAreas()) {
      try { if (ta.description() === '메시지 입력') { box = ta; break; } } catch (e) {}
    }
    if (box) break;
  }
  if (!box) return JSON.stringify({ ok: false, step: 'NO_INPUT' });
  const cur = box.value() || '';
  if (mode === 'clear') { box.value = ''; return JSON.stringify({ ok: (box.value() || '') === '', step: 'CLEARED' }); }
  if (cur.length) return JSON.stringify({ ok: false, step: 'BOX_NOT_EMPTY', head: cur.slice(0, 40) });
  ObjC.import('Foundation');
  const msg = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null));
  if (typeof msg !== 'string' || !msg.length) return JSON.stringify({ ok: false, step: 'FILE_READ', file });
  box.value = msg;
  delay(0.5);
  const got = (box.value() || '').replace(/\r\n?/g, '\n');
  if (got !== msg.replace(/\r\n?/g, '\n')) {
    let i = 0;
    while (i < got.length && got[i] === msg[i]) i++;
    box.value = '';
    return JSON.stringify({ ok: false, step: 'VALUE_MISMATCH', want: msg.length, got: got.length, at: i, wantCh: msg.charCodeAt(i), gotCh: got.charCodeAt(i) });
  }
  if (mode !== 'send') return JSON.stringify({ ok: true, step: 'SET_ONLY', len: msg.length });
  const btns = w.buttons.whose({ name: '전송' })();
  if (!btns.length) return JSON.stringify({ ok: false, step: 'NO_SEND_BUTTON' });
  try { btns[0].actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
  delay(1);
  return JSON.stringify({ ok: true, step: 'PRESSED', boxAfter: (box.value() || '').length });
}

// 카톡 채팅 창(이미 열린 창)에 글을 넣고 전송한다. 사용자의 마우스·키보드를 쓰지 않는다(System Events 접근성만).
// 창·입력칸·버튼 이름(KakaoTalk, 메시지 입력, 전송)은 한국어 UI에서 확인한 값이다.
// 사용: osascript -l JavaScript kakao-send-ui.js <창 제목> <글 파일> <set|send|clear>
//  set   : 입력칸이 비어 있을 때만 글을 넣고 그대로 둔다(확인용)
//  send  : 입력칸이 비어 있을 때만 글을 넣고 전송 버튼을 누른다
//  clear : 입력칸에 이 글과 똑같은 글이 있을 때만 비운다(사용자가 치던 글은 건드리지 않음)
// 출력: 한 줄 JSON {ok, step, ...}
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
ObjC.import('Foundation');

function kakaoProcess(se) {
  const env = $.NSProcessInfo.processInfo.environment;
  const get = (k) => { const v = env.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); };
  const bundle = get('KAKAO_BUNDLE_ID') || 'com.kakao.KakaoTalkMac';
  const pid = Number(get('KAKAO_PID') || 0);
  if (pid) {
    const ps = se.processes.whose({ unixId: pid })();
    if (!ps.length) return { err: 'NO_APP', pid };
    const b = ps[0].bundleIdentifier();
    if (b !== bundle) return { err: 'WRONG_APP', pid, bundle: b, want: bundle };
    return { p: ps[0] };
  }
  const ps = se.processes.whose({ bundleIdentifier: bundle })();
  if (!ps.length) return { err: 'NO_APP', bundle };
  if (ps.length > 1) return { err: 'APP_COUNT', bundle, n: ps.length };
  return { p: ps[0] };
}

function run(argv) {
  const [title, file, mode] = argv;
  let phase = 'start';
  try {
    const se = Application('System Events');
    const k = kakaoProcess(se);
    if (k.err) return JSON.stringify(Object.assign({ ok: false, step: k.err }, k));
    const p = k.p;
    const msg = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null));
    if (typeof msg !== 'string' || !msg.length) return JSON.stringify({ ok: false, step: 'FILE_READ', file });
    const norm = (s) => (s || '').replace(/\r\n?/g, '\n');
    // 같은 제목 창이 여러 개일 수 있고(같은 이름 창 2개를 실제로 겪었다), 카톡이 잠깐 접근성 응답을 안 줄 때가 있어(-1728) 최대 3번 다시 찾는다.
    const find = () => {
      for (let t = 0; t < 3; t++) {
        try {
          for (const w of p.windows()) {
            let name = '';
            try { name = w.name(); } catch (e) { continue; }
            if (name !== title) continue;
            for (const sa of w.scrollAreas()) {
              for (const ta of sa.textAreas()) {
                try { if (ta.description() === '메시지 입력') return { w, box: ta, tries: t + 1 }; } catch (e) {}
              }
            }
          }
        } catch (e) {}
        delay(1);
      }
      return null;
    };
    phase = 'find';
    let f = find();
    if (!f) return JSON.stringify({ ok: false, step: 'WINDOW_NOT_OPEN', title });
    phase = 'read';
    const cur = norm(f.box.value());
    if (mode === 'clear') {
      // 사용자가 치던 글을 지우지 않는다: 우리가 넣은 글과 똑같을 때만 비운다(10/14 21:2x 사고).
      if (!cur.length) return JSON.stringify({ ok: true, step: 'ALREADY_EMPTY' });
      if (cur !== norm(msg)) return JSON.stringify({ ok: false, step: 'NOT_OURS', head: cur.slice(0, 40) });
      phase = 'clear';
      f.box.value = '';
      return JSON.stringify({ ok: (f.box.value() || '') === '', step: 'CLEARED' });
    }
    if (cur.length) return JSON.stringify({ ok: false, step: 'BOX_NOT_EMPTY', head: cur.slice(0, 40) });
    phase = 'set';
    f.box.value = msg;
    delay(0.5);
    phase = 'verify';
    let got;
    try { got = norm(f.box.value()); } catch (e) { f = find(); if (!f) return JSON.stringify({ ok: false, step: 'LOST_AFTER_SET', err: String(e) }); got = norm(f.box.value()); }
    if (got !== norm(msg)) {
      let i = 0;
      while (i < got.length && got[i] === msg[i]) i++;
      f.box.value = '';
      return JSON.stringify({ ok: false, step: 'VALUE_MISMATCH', want: msg.length, got: got.length, at: i, wantCh: msg.charCodeAt(i), gotCh: got.charCodeAt(i) });
    }
    if (mode !== 'send') return JSON.stringify({ ok: true, step: 'SET_ONLY', len: msg.length, tries: f.tries });
    phase = 'press';
    const btns = f.w.buttons.whose({ name: '전송' })();
    if (!btns.length) return JSON.stringify({ ok: false, step: 'NO_SEND_BUTTON' });
    try { btns[0].actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
    delay(1);
    let after = -1;
    try { after = (f.box.value() || '').length; } catch (e) {}
    return JSON.stringify({ ok: true, step: 'PRESSED', boxAfter: after });
  } catch (e) {
    return JSON.stringify({ ok: false, step: 'AX_ERROR', phase, err: String(e) });
  }
}

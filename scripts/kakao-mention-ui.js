// 열린 카카오톡 채팅 창 입력칸에 진짜 멘션 칩을 만들고 글을 이어 붙인다. 붙여 넣은 「@이름」 글자는 멘션이 안 된다.
// 사용: osascript -l JavaScript kakao-mention-ui.js <창 제목> <글 파일> <set|send> <이름1> [이름2 ...]
//  set  : 칩과 글을 넣고 그대로 둔다(보내지 않는다) — 끝나면 kakao-send-ui.js clear로 비운다
//  send : 칩과 글을 넣고 「전송」 버튼을 누른다
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 순서(이름마다): 입력칸 초점 → Shift+2 키 이벤트를 카톡 PID에만 보내 「@」(CGEventPostToPid — 창을 앞으로 올리지 않는다)
//   → 고르기 창(입력칸 위 두 번째 표) 기다림 → 이름을 AXSelectedText로 넣어 목록을 거른다(입력기를 거치지 않아 한글도 그대로)
//   → 이름이 똑같은 줄이 정확히 1개일 때만 그 줄을 선택 → Return 직전에 고르기 창을 새로 읽어 같은 줄이 여전히 하나이고
//     선택돼 있는지, 입력칸에 그 이름이 남아 있는지 다시 본다 → Return → 입력칸의 칩 문자(U+FFFC) 수가 늘었는지 확인.
//   Return 직전 재확인은 실제 사고에서 나왔다: 「@이름」 글자만 나갔고, 고르기 창이 다시 걸러지는 사이 Return이 입력칸에 들어간 것으로 보인다.
// PID로 보낸 키는 그 앱의 주 창(AXMain)으로 간다. 입력칸 초점만 주면 「@」가 다른 방 입력칸에 들어간다(2026-10-31 실측) —
// 그래서 키를 보내기 전에 대상 창을 AXMain으로 만들고(카톡을 앞으로 띄우지 않는다), 주 창이 아니면 WINDOW_NOT_MAIN으로 멈춘다.
// 칩 뒤에는 카톡이 빈칸 하나를 붙인다. 이름을 다 넣으면 글을 AXSelectedText로 이어 붙인다(값을 통째로 바꾸면 칩이 지워진다).
// 실패하면 입력칸을 비우고(처음에 비어 있던 칸이라 남은 것은 이 스크립트가 넣은 것) 멈춘다. 쓰던 앱은 그대로 앞에 둔다.
// 출력: 한 줄 JSON {ok, step, value?, returned, ...}. returned는 실제로 보낸 Return 수 — 0이 아닌데 실패했으면
// 글이 새어 나갔을 수 있으니 DB에서 내 새 글을 확인한다(kakao-send.py가 LEAKED로 알린다). 전송 성공 판정은 DB attachment.mentions.
ObjC.import('Foundation');
ObjC.import('CoreGraphics');

const CHIP = '\uFFFC';

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
  const names = argv.slice(3);
  const se = Application('System Events');
  const out = { ok: false, step: '', names, returned: 0 };
  const done = (o) => JSON.stringify(Object.assign(out, o));
  if (mode !== 'set' && mode !== 'send') return done({ step: 'BAD_MODE' });
  if (!names.length) return done({ step: 'NO_NAMES' });
  const msg = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null));
  if (typeof msg !== 'string') return done({ step: 'FILE_READ' });

  let p;
  try {
    const k = kakaoProcess(se);
    if (k.err) return done(Object.assign({ step: k.err }, k));
    p = k.p;
  } catch (e) { return done({ step: 'AX_ERROR', err: String(e).slice(0, 200) }); }
  const w = (() => { try { return p.windows().find((x) => { try { return x.name() === title; } catch (e) { return false; } }); } catch (e) { return null; } })();
  if (!w) return done({ step: 'WINDOW_NOT_OPEN', title });
  let box = null;
  for (const sa of w.scrollAreas()) for (const t of sa.textAreas()) { try { if (/메시지 입력/.test(t.description())) box = t; } catch (e) {} }
  if (!box) return done({ step: 'NO_INPUT_BOX' });
  const val = () => String(box.value() || '').replace(/\r\n?/g, '\n');
  if (val().length) return done({ step: 'BOX_NOT_EMPTY', head: val().slice(0, 40) });

  // 고르기 창: 표가 든 스크롤 영역 중 첫 번째(대화 기록)를 뺀 것
  const picker = () => {
    try {
      const sas = w.scrollAreas();
      for (let i = 1; i < sas.length; i++) { try { if (sas[i].tables().length) return sas[i].tables()[0]; } catch (e) {} }
    } catch (e) {}
    return null;
  };
  const rowName = (r) => { try { const st = r.uiElements()[0].staticTexts(); return st.length ? String(st[0].value()) : ''; } catch (e) { return ''; } };
  const chips = () => val().split(CHIP).length - 1;
  const pid = p.unixId();
  const key = (code, shift) => {
    for (const down of [true, false]) {
      const ev = $.CGEventCreateKeyboardEvent($(), code, down);
      if (shift) $.CGEventSetFlags(ev, $.kCGEventFlagMaskShift);
      $.CGEventPostToPid(pid, ev);
    }
  };

  const prev = (() => { try { return se.processes.whose({ frontmost: true })()[0]; } catch (e) { return null; } })();
  const restore = () => { try { if (prev && prev.unixId() !== p.unixId()) prev.frontmost = true; } catch (e) {} };
  const fail = (o) => { try { box.value = ''; } catch (e) {} out.cleared = (() => { try { return val() === ''; } catch (e) { return null; } })(); restore(); return done(o); };

  const isMain = () => { try { return w.attributes.byName('AXMain').value() === true; } catch (e) { return false; } };
  const makeMain = () => {
    if (isMain()) return true;
    try { w.attributes.byName('AXMain').value = true; } catch (e) {}
    for (let i = 0; i < 8 && !isMain(); i++) delay(0.15);
    return isMain();
  };

  try {
    box.focused = true; delay(0.3);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      if (!makeMain()) return fail({ step: 'WINDOW_NOT_MAIN', name, k });
      box.focused = true; delay(0.2);
      const before = chips();
      key(19, true);  // 키 코드 19 = 숫자 2, Shift와 함께 = @
      let tb = null;
      for (let i = 0; i < 20 && !tb; i++) { delay(0.15); tb = picker(); }
      if (!tb) return fail({ step: 'PICKER_NOT_SHOWN', name, k });
      box.attributes.byName('AXSelectedText').value = name;
      // 사람이 많은 방은 거르는 데 시간이 걸린다 — 이름이 똑같은 줄이 생기고 목록 크기가 멈출 때까지 최대 약 3초
      let hits = [], rows = [], last = -1;
      for (let i = 0; i < 15; i++) {
        delay(0.2);
        tb = picker();
        if (!tb) break;
        try { rows = tb.rows(); } catch (e) { rows = []; hits = []; last = -1; continue; }
        hits = [];
        for (let j = 0; j < rows.length; j++) if (rowName(rows[j]) === name) hits.push(j);
        if (hits.length && rows.length === last) break;
        last = rows.length;
      }
      if (!tb) return fail({ step: 'PICKER_CLOSED', name, k });
      if (hits.length !== 1) {
        return fail({ step: hits.length ? 'MENTION_AMBIGUOUS' : 'MENTION_NOT_FOUND', name, k, same: hits.length, rows: rows.length });
      }
      try { rows[hits[0]].attributes.byName('AXSelected').value = true; } catch (e) {}
      delay(0.25);
      let selected = false;
      try { selected = rows[hits[0]].attributes.byName('AXSelected').value(); } catch (e) {}
      if (!selected) return fail({ step: 'ROW_NOT_SELECTED', name, k });
      // 고르기 창 없이 Return이면 글이 그대로 나간다
      const tb2 = picker();
      if (!tb2) return fail({ step: 'PICKER_CLOSED_BEFORE_RETURN', name, k });
      let rows2 = [];
      try { rows2 = tb2.rows(); } catch (e) { return fail({ step: 'ROWS_UNREADABLE_BEFORE_RETURN', name, k }); }
      const same = [];
      for (let j = 0; j < rows2.length; j++) if (rowName(rows2[j]) === name) same.push(j);
      if (same.length !== 1) return fail({ step: 'ROW_CHANGED_BEFORE_RETURN', name, k, same: same.length, rows: rows2.length });
      let stillSelected = false;
      try { stillSelected = rows2[same[0]].attributes.byName('AXSelected').value(); } catch (e) {}
      if (!stillSelected) return fail({ step: 'ROW_NOT_SELECTED_BEFORE_RETURN', name, k });
      if (val().indexOf(name) < 0) return fail({ step: 'BOX_CHANGED_BEFORE_RETURN', name, k });
      out.returned += 1;
      key(36, false);  // 키 코드 36 = Return
      let ok = false;
      for (let i = 0; i < 10 && !ok; i++) { delay(0.15); ok = chips() === before + 1; }
      if (!ok) return fail({ step: 'CHIP_NOT_MADE', name, k });
    }
    if (msg.length) {
      box.attributes.byName('AXSelectedText').value = msg;
      delay(0.4);
    }
    const v = val();
    out.value = v;
    out.chips = chips();
    if (out.chips !== names.length || !v.endsWith(msg.replace(/\r\n?/g, '\n'))) return fail({ step: 'VALUE_MISMATCH' });
    if (mode === 'set') { restore(); return done({ ok: true, step: 'SET_ONLY' }); }
    const btns = w.buttons.whose({ name: '전송' })();
    if (!btns.length) return fail({ step: 'NO_SEND_BUTTON' });
    try { btns[0].actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
    delay(1);
    try { out.boxAfter = val().length; } catch (e) {}
    restore();
    return done({ ok: true, step: 'PRESSED' });
  } catch (e) {
    return fail({ step: 'AX_ERROR', err: String(e).slice(0, 200) });
  }
}

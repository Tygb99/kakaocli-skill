// 카카오톡의 열린 채팅 창에서 이모티콘 창을 열고, 고른 이모티콘을 전송하고, 이모티콘 창을 닫는다(System Events 접근성만).
// 이모티콘 창의 탭·칸에는 접근성 누르기 동작이 없어, 고르는 일은 kakao-send.py가 Aside Computer Use(aside_cu.py)로 한다.
// 사용: osascript -l JavaScript kakao-emoticon-ui.js <창 제목> <open|cells|send|close> [스크롤 값]
//  open  : 입력칸이 비어 있고 붙은 것이 없을 때만 「이모티콘 ⌘E」 단추를 눌러 이모티콘 창을 연다(이미 열려 있으면 그대로). 출력 picker = [x, y, 너비, 높이]
//  cells : 이모티콘 창 격자에 지금 올라와 있는 칸들의 실제 번호(indexes, 0부터 = 이모티콘 순번 - 1)와 화면 안에 있는지(shown).
//          격자는 보이는 칸 근처만 올려 두므로(처음 20칸), 스크롤 값(0~1)을 주면 그 자리로 옮긴 뒤에 읽는다
//  send  : 입력칸이 비어 있는데 「전송」이 켜져 있으면(= 이모티콘이 붙어 있으면) 「전송」을 누른다. 아니면 NOT_ATTACHED
//  close : 이모티콘 창이 열려 있으면 닫는다(보내고 나면 카톡이 스스로 닫는다)
// 창·버튼 이름(메시지 입력, 이모티콘, 미니 이모티콘, 전송)은 한국어 UI에서 확인한 값이다.
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 출력: 한 줄 JSON {ok, step, ...}. 실제 전송 성공 판정은 이 출력이 아니라 DB의 새 행.
ObjC.import('Foundation');
ObjC.import('CoreGraphics');

// 이모티콘 창을 열거나 보내는 사이 카톡 창이 사용자가 보던 창 위로 올라올 때가 있다. 화면 맨 위 보통 창이 카톡 것이고
// 카톡이 맨 앞 앱이 아니면, 그 순간 맨 앞 앱의 초점 창을 다시 맨 위로 올린다(kakao-open-ui.js와 같은 함수).
function restoreFront(se, p) {
  try {
    const front = se.processes.whose({ frontmost: true })()[0];
    const pid = p.unixId();
    if (front.unixId() === pid) return null;
    const windows = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));
    const top = windows.find((w) => w.kCGWindowLayer === 0);
    if (!top || top.kCGWindowOwnerPID !== pid) return false;
    front.attributes.byName('AXFocusedWindow').value().actions.byName('AXRaise').perform();
    return true;
  } catch (e) { return null; }
}

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
  const [title, mode] = argv;
  const out = { ok: false, step: '' };
  const se = Application('System Events');
  let app = null;
  const done = (o) => {
    Object.assign(out, o);
    if (app) { const raised = restoreFront(se, app); if (raised !== null) out.frontRaised = raised; }
    return JSON.stringify(out);
  };
  if (['open', 'cells', 'send', 'close'].indexOf(mode) < 0) return done({ step: 'BAD_MODE' });
  try {
    const k = kakaoProcess(se);
    if (k.err) return done(Object.assign({ step: k.err }, k));
    const p = k.p;
    app = p;
    const pickers = () => p.windows().filter((x) => { try { return x.subrole() === 'AXDialog' && x.buttons.description().indexOf('미니 이모티콘') >= 0; } catch (e) { return false; } });
    if (mode === 'close') {
      const ws = pickers();
      for (const x of ws) {
        const top = x.position()[1];
        const b = x.buttons().find((c) => { try { return c.size()[0] <= 20 && c.position()[1] - top < 24; } catch (e) { return false; } });
        try { if (b) b.actions.byName('AXPress').perform(); } catch (e) { /* 같은 창이 목록에 두 번 나와 두 번째 누르기는 이미 닫힌 창일 수 있다 */ }
      }
      delay(ws.length ? 0.6 : 0);
      return done({ ok: !pickers().length, step: 'CLOSED', had: ws.length });
    }
    if (mode === 'cells') {
      const ws = pickers();
      if (!ws.length) return done({ step: 'NO_PICKER' });
      const area = ws[0].scrollAreas[1];
      if (argv[2]) { area.scrollBars[0].value = Number(argv[2]); delay(0.5); }
      const cells = area.uiElements[0].uiElements[0].uiElements;
      const top = area.position()[1], bottom = top + area.size()[1];
      const pos = cells.position(), size = cells.size();
      return done({
        ok: true, step: 'CELLS', indexes: cells.attributes.byName('AXIndex').value(),
        shown: pos.map((xy, i) => xy[1] >= top - 1 && xy[1] + size[i][1] <= bottom + 1),
      });
    }
    let box = null;
    const w = p.windows().find((x) => {
      try {
        if (x.name() !== title) return false;
        for (const sa of x.scrollAreas()) for (const ta of sa.textAreas()) { if (ta.description() === '메시지 입력') { box = ta; return true; } }
      } catch (e) {}
      return false;
    });
    if (!w) return done({ step: 'WINDOW_NOT_OPEN', title });
    if (w.sheets.length) return done({ step: 'SHEET_ALREADY_OPEN' });
    if (String(box.value() || '').length) return done({ step: 'BOX_NOT_EMPTY' });
    const send = w.buttons.whose({ name: '전송' })()[0];
    if (!send) return done({ step: 'NO_SEND_BUTTON' });
    // 입력칸이 비어 있을 때 「전송」은 꺼져 있다. 켜져 있으면 이모티콘·사진이 붙어 있다는 뜻이다.
    const attached = () => { try { return send.enabled() === true; } catch (e) { return false; } };
    if (mode === 'send') {
      if (!attached()) return done({ step: 'NOT_ATTACHED' });
      try { send.actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
      return done({ ok: true, step: 'PRESSED' });
    }
    if (attached()) return done({ step: 'ALREADY_ATTACHED' });
    let ws = pickers();
    if (!ws.length) {
      const btn = w.buttons().find((b) => { try { return String(b.help() || '').indexOf('이모티콘') === 0; } catch (e) { return false; } });
      if (!btn) return done({ step: 'NO_EMOTICON_BUTTON' });
      btn.actions.byName('AXPress').perform();
      for (let i = 0; i < 30 && !ws.length; i++) { delay(0.1); ws = pickers(); }
      if (!ws.length) return done({ step: 'NO_PICKER' });
      out.opened = true;
    }
    return done({ ok: true, step: 'PICKER_OPEN', picker: ws[0].position().concat(ws[0].size()) });
  } catch (e) {
    return done({ step: 'AX_ERROR', err: String(e).slice(0, 200) });
  }
}

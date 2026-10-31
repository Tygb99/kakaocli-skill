// 열린 카카오톡 채팅 창에서 글 하나에 「답장」(오픈채팅은 「댓글」)을 열고 글을 넣어 보낸다. 키 입력·마우스·클립보드를 쓰지 않는다.
// 사용: osascript -l JavaScript kakao-reply-ui.js <창 제목> <open|set|send|close> <원글 JSON 파일> [글 파일]
//  원글 JSON: {"text": 원글 내용(DB message), "author": 작성자 이름(그 방에 보이는 이름), "self": 내 글이면 true}
//  open  : 원글 말풍선을 찾아 「답장」을 열고(입력칸은 비운 채) 멈춘다 — 멘션은 그다음 kakao-mention-ui.js가 넣는다
//  set   : open + 글을 넣는다(보내지 않는다)
//  send  : set + 「전송」 버튼
//  close : 답장 상태면 입력칸을 비우고 답장 「닫기」를 누른다(시작할 때 빈 칸이었으므로 남은 것은 이 스크립트·멘션 스크립트가 넣은 것)
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 원글 찾기: 대화 표의 말풍선(AXTextArea) 값이 원글과 똑같은 것이 정확히 하나일 때만 진행한다.
//   표에 없으면 스크롤 막대를 맨 위로(최대 5번) 옮겨 이전 기록을 불러 찾는다. AXScrollUpByPage는 이 표에서 아무 일도 안 한다.
//   표에는 화면 밖 말풍선도 들어 있는데 화면 밖 말풍선에는 AXShowMenu가 메뉴를 안 띄운다 — 스크롤 막대 값을 계산해 가운데로 옮긴다.
// 「답장」을 누른 뒤 입력칸 위 인용이 원글과 같고 머리글이 「<작성자>에게 답장」(내 글이면 「나에게 답장」)인지 다시 보고, 아니면 닫고 멈춘다.
// 답장 상태 입력칸의 설명은 「답장 메시지 입력」(오픈채팅 「댓글 메시지 입력」), 답장 닫기 단추 설명은 「닫기」(창 닫기 단추는 「닫기 버튼」).
// Return 키는 쓰지 않는다. 출력: 한 줄 JSON {ok, step, ...}. 실제 전송·답장 연결 판정은 DB(type 26 + attachment.src_logId, 또는 scope 3 + threadId).
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
  const [title, mode, targetFile, msgFile] = argv;
  const out = { ok: false, step: '', mode };
  const done = (o) => JSON.stringify(Object.assign(out, o));
  if (['open', 'set', 'send', 'close'].indexOf(mode) < 0) return done({ step: 'BAD_MODE' });
  const readFile = (f) => ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(f, $.NSUTF8StringEncoding, null));
  let target = null;
  let msg = '';
  if (mode !== 'close') {
    try { target = JSON.parse(readFile(targetFile)); } catch (e) { return done({ step: 'TARGET_READ' }); }
    if (!target || typeof target.text !== 'string' || !target.text.length) return done({ step: 'TARGET_READ' });
    if (mode !== 'open') {
      msg = readFile(msgFile);
      if (typeof msg !== 'string' || !msg.length) return done({ step: 'FILE_READ' });
    }
  }
  const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/\r\n?/g, '\n');
  const flat = (s) => norm(s).replace(/\s+/g, ' ').trim();

  const se = Application('System Events');
  let p;
  try {
    const k = kakaoProcess(se);
    if (k.err) return done(Object.assign({ step: k.err }, k));
    p = k.p;
  } catch (e) { return done({ step: 'AX_ERROR', err: String(e).slice(0, 200) }); }
  const w = (() => { try { return p.windows().find((x) => { try { return x.name() === title; } catch (e) { return false; } }); } catch (e) { return null; } })();
  if (!w) return done({ step: 'WINDOW_NOT_OPEN', title });

  const header = () => { try { return w.staticTexts.value().find((v) => /에게 (답장|댓글)$/.test(String(v))) || null; } catch (e) { return null; } };
  const box = () => {
    try {
      for (const sa of w.scrollAreas()) for (const t of sa.textAreas()) { try { const d = String(t.description()); if (/메시지 입력/.test(d)) return { el: t, desc: d }; } catch (e) {} }
    } catch (e) {}
    return null;
  };
  const closeBtn = () => { try { return w.buttons().find((b) => { try { return b.description() === '닫기'; } catch (e) { return false; } }) || null; } catch (e) { return null; } };
  const closeReply = () => {
    const r = { hadPanel: !!header() };
    const b = box();
    if (!r.hadPanel) {
      try { r.boxEmpty = b ? norm(b.el.value()) === '' : null; } catch (e) { r.boxEmpty = null; }
      return r;
    }
    try { if (b && norm(b.el.value()).length) b.el.value = ''; } catch (e) {}
    const c = closeBtn();
    if (!c) { r.closed = false; r.err = 'NO_CLOSE_BUTTON'; return r; }
    try { c.actions.byName('AXPress').perform(); } catch (e) {}
    for (let i = 0; i < 12 && header(); i++) delay(0.25);
    r.closed = !header();
    const b2 = box();
    r.boxDesc = b2 ? b2.desc : null;
    try { r.boxEmpty = b2 ? norm(b2.el.value()) === '' : null; } catch (e) { r.boxEmpty = null; }
    return r;
  };
  const failClose = (o) => { out.cleanup = closeReply(); return done(o); };

  try {
    if (mode === 'close') {
      const r = closeReply();
      return done({ ok: (!r.hadPanel || r.closed) && r.boxEmpty === true, step: r.hadPanel ? 'CLOSED' : 'NO_PANEL', cleanup: r });
    }
    // 이미 답장 상태면 사용자가 연 것일 수 있어 건드리지 않는다
    if (header()) return done({ step: 'REPLY_ALREADY_OPEN', header: header() });
    const b0 = box();
    if (!b0) return done({ step: 'NO_INPUT_BOX' });
    if (norm(b0.el.value()).length) return done({ step: 'BOX_NOT_EMPTY', head: norm(b0.el.value()).slice(0, 40) });

    // 말풍선 값은 한 번에 읽는다(줄마다 읽으면 130줄에 37초 걸렸다)
    const sa0 = w.scrollAreas()[0];
    const tb = sa0.tables()[0];
    const want = norm(target.text);
    const scan = () => {
      let vals = null;
      try { vals = tb.rows.uiElements.textAreas.value(); } catch (e) { vals = null; }
      const hits = [];
      if (vals) {
        vals.forEach((cells, i) => (cells || []).forEach((tas, c) => (tas || []).forEach((v, j) => { if (norm(v) === want) hits.push([i, c, j]); })));
        return { hits, rows: vals.length };
      }
      const rows = tb.rows();
      rows.forEach((r, i) => { try { r.uiElements().forEach((cell, c) => { try { cell.textAreas().forEach((t, j) => { if (norm(t.value()) === want) hits.push([i, c, j]); }); } catch (e) {} }); } catch (e) {} });
      return { hits, rows: rows.length, slow: true };
    };
    const sb = (() => { try { return sa0.scrollBars()[0]; } catch (e) { return null; } })();
    let s = scan();
    let pages = 0;
    while (!s.hits.length && sb && pages < 5) {
      // 스크롤 막대 값 0 = 맨 위. 맨 위로 가면 카톡이 이전 기록을 더 불러온다
      try { sb.value = 0; } catch (e) { break; }
      pages++;
      delay(1);
      s = scan();
    }
    out.rows = s.rows; out.pages = pages; out.hitCount = s.hits.length;
    if (!s.hits.length) return done({ step: 'TARGET_NOT_ON_SCREEN' });
    if (s.hits.length > 1) return done({ step: 'TARGET_AMBIGUOUS', hits: s.hits });
    // 스크롤 막대 값 = (말풍선 위 - 표 위 + 말풍선 높이/2 - 영역 높이/2) / (표 높이 - 영역 높이)
    const [ri, ci, ti] = s.hits[0];
    const bubble = tb.rows[ri].uiElements[ci].textAreas[ti];
    const [saY, saH] = [sa0.position()[1], sa0.size()[1]];
    const visible = () => { const y = bubble.position()[1]; const h = bubble.size()[1]; const cy = y + h / 2; return (cy >= saY && cy <= saY + saH) || (y <= saY && y + h >= saY + saH); };
    let moves = 0;
    while (!visible()) {
      if (!sb || moves >= 4) return done({ step: 'TARGET_NOT_VISIBLE', moves });
      const ty = tb.position()[1]; const th = tb.size()[1];
      const off = (bubble.position()[1] - ty) + bubble.size()[1] / 2 - saH / 2;
      try { sb.value = Math.max(0, Math.min(1, off / Math.max(1, th - saH))); } catch (e) { return done({ step: 'SCROLL_FAILED', err: String(e).slice(0, 120) }); }
      moves++;
      delay(0.4);
    }
    out.moves = moves;
    if (norm(bubble.value()) !== want) return done({ step: 'TARGET_MOVED' });

    bubble.actions.byName('AXShowMenu').perform();
    let menu = null;
    for (let i = 0; i < 12 && !menu; i++) { try { if (bubble.menus.length) menu = bubble.menus[0]; } catch (e) {} if (!menu) delay(0.25); }
    if (!menu) return done({ step: 'NO_BUBBLE_MENU' });
    // 1:1·일반방 메뉴에는 「답장」, 오픈채팅 메뉴에는 「댓글」만 있다
    let names = null;
    for (let i = 0; i < 4 && !names; i++) { try { names = menu.menuItems.name().map(String); } catch (e) { delay(0.3); } }
    if (!names) return done({ step: 'MENU_UNREADABLE' });
    const kind = names.indexOf('답장') >= 0 ? '답장' : names.indexOf('댓글') >= 0 ? '댓글' : null;
    out.kind = kind;
    if (!kind) {
      out.menuItems = names.filter((x) => x && x !== 'null');
      try { menu.actions.byName('AXCancel').perform(); } catch (e) {}
      return done({ step: 'NO_REPLY_ITEM' });
    }
    try { menu.menuItems.byName(kind).actions.byName('AXPress').perform(); } catch (e) { return failClose({ step: 'MENU_PRESS_FAILED', err: String(e).slice(0, 120) }); }
    let h = null;
    for (let i = 0; i < 16 && !h; i++) { delay(0.25); h = header(); }
    if (!h) return done({ step: 'REPLY_PANEL_NOT_SHOWN' });
    out.header = h;
    let quotes = [];
    try { quotes = w.textAreas.value().map(norm); } catch (e) {}
    out.quote = (quotes[0] || '').slice(0, 60);
    const fw = flat(want);
    // 인용은 첫 줄만 보이고 「…」로 잘릴 수 있다 — 앞 10자 이상이 원글 앞부분과 같으면 같은 글로 본다
    const quoteOk = quotes.some((q) => { const fq = flat(q).replace(/(…|\.\.\.)$/, '').trim(); return fq === fw || (fq.length >= Math.min(10, fw.length) && fw.startsWith(fq)); });
    if (!quoteOk) return failClose({ step: 'REPLY_TARGET_MISMATCH', why: 'quote' });
    const author = String(target.author || '');
    const headerOk = h === author + '에게 ' + kind || (target.self === true && h === '나에게 ' + kind);
    if (!headerOk) return failClose({ step: 'REPLY_TARGET_MISMATCH', why: 'header', author });

    const b = box();
    if (!b || b.desc !== kind + ' 메시지 입력') return failClose({ step: 'NO_REPLY_BOX', desc: b ? b.desc : null });
    if (norm(b.el.value()).length) return failClose({ step: 'BOX_NOT_EMPTY_AFTER_REPLY' });
    if (mode === 'open') return done({ ok: true, step: 'REPLY_OPEN' });

    b.el.value = msg;
    delay(0.5);
    const got = norm(b.el.value());
    if (got !== norm(msg)) return failClose({ step: 'VALUE_MISMATCH', want: msg.length, got: got.length });
    if (mode === 'set') return done({ ok: true, step: 'SET_ONLY', len: msg.length });

    const btns = w.buttons.whose({ name: '전송' })();
    if (!btns.length) return failClose({ step: 'NO_SEND_BUTTON' });
    // 답장 상태가 풀렸으면 보통 글로 나간다
    if (!header()) return failClose({ step: 'REPLY_CLOSED_BEFORE_SEND' });
    try { btns[0].actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
    delay(1);
    try { const b2 = box(); out.boxAfter = b2 ? norm(b2.el.value()).length : -1; } catch (e) {}
    out.panelAfter = !!header();
    return done({ ok: true, step: 'PRESSED' });
  } catch (e) {
    return failClose({ step: 'AX_ERROR', err: String(e).slice(0, 200) });
  }
}

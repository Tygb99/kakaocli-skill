// 열린 카카오톡 채팅 창에서 글 하나에 「답장」(오픈채팅은 「댓글」)을 열고 글을 넣어 보낸다. 키 입력·마우스·클립보드를 쓰지 않는다.
// 사용: osascript -l JavaScript kakao-reply-ui.js <창 제목> <open|set|send|close|restore> <원글 JSON 파일> [글 파일]
//  원글 JSON: {"text": 원글 내용(DB message), "author": 작성자 이름(그 방에 보이는 이름), "self": 내 글이면 true,
//             "kind": "text"|"media"(사진·동영상·파일), "dup": 같은 내용 글이 방에 또 있으면 true,
//             "before"/"after": 원글 앞·뒤 글 표시(가까운 것부터, "T:<글>" 또는 "M"=사진·동영상·파일), "search": 돋보기 검색어, "quotes": 사진·파일 인용에 보일 말}
//  restore: 돋보기 검색 칸을 닫고 「최하단으로」를 눌러 최신 글로 돌아간다(close도 끝에 한다)
//  open  : 원글 말풍선을 찾아 「답장」을 열고(입력칸은 비운 채) 멈춘다 — 멘션은 그다음 kakao-mention-ui.js가 넣는다
//  set   : open + 글을 넣는다(보내지 않는다)
//  send  : set + 「전송」 버튼
//  close : 답장 상태면 입력칸을 비우고 답장 「닫기」를 누른다(시작할 때 빈 칸이었으므로 남은 것은 이 스크립트·멘션 스크립트가 넣은 것)
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 원글 찾기: 대화 표의 말풍선(AXTextArea) 값이 원글과 똑같은 것이 정확히 하나일 때만 진행한다.
//   표에 없으면 맨 아래 → 돋보기(대화 내 검색) → 스크롤 막대 맨 위(최대 5번, 이전 기록을 더 불러옴) 순서로 찾는다. AXScrollUpByPage는 이 표에서 아무 일도 안 한다.
//   돋보기: 머리 「검색」 단추 → 「텍스트 필드 검색」 칸에 값 + AXConfirm이면 그 글 근처만 불러와 그 글로 옮긴다(수백 줄 전 글도 몇 초).
//   같은 칸에서 검색어만 바꾸면 움직이지 않는다 — 칸이 열려 있으면 「검색」을 한 번 눌러 닫고 다시 연다. 끝나면 칸을 닫고 「최하단으로」(AXPress 됨)로 최신 글에 돌아간다.
//   같은 내용 글이 둘 이상이거나 원글이 사진·동영상·파일(말풍선: 「공유」 단추 + 그림, 글칸 없음)이면 표의 앞뒤 글을 DB 앞뒤 글(before/after)과 맞춰
//   앞뒤 최대 5개가 모두 같은 자리 하나만 고른다. 둘 이상 맞으면 TARGET_AMBIGUOUS, 하나도 안 맞으면 아직 표에 없는 것으로 보고 다음 방법으로 넘어간다.
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
  if (['open', 'set', 'send', 'close', 'restore'].indexOf(mode) < 0) return done({ step: 'BAD_MODE' });
  const readFile = (f) => ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(f, $.NSUTF8StringEncoding, null));
  let target = null;
  let msg = '';
  if (mode !== 'close' && mode !== 'restore') {
    try { target = JSON.parse(readFile(targetFile)); } catch (e) { return done({ step: 'TARGET_READ' }); }
    if (!target || (target.kind !== 'media' && (typeof target.text !== 'string' || !target.text.length))) return done({ step: 'TARGET_READ' });
    if (mode !== 'open') {
      msg = readFile(msgFile);
      if (typeof msg !== 'string' || !msg.length) return done({ step: 'FILE_READ' });
    }
  }
  const norm = (s) => String(s === null || s === undefined ? '' : s).replace(/\r\n?/g, '\n');
  const flat = (s) => norm(s).replace(/\s+/g, ' ').trim();
  // 시험용: 환경변수 KAKAO_FAULT=partial 이면 글을 넣은 뒤 일부러 앞 14자만 남겨 「넣는 도중 실패」를 만든다(뒷정리 시험용)
  const fault = () => { try { const v = $.NSProcessInfo.processInfo.environment.objectForKey('KAKAO_FAULT'); return v.isNil() ? '' : ObjC.unwrap(v); } catch (e) { return ''; } };

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
  // 값 지우기가 한 번에 안 먹을 때가 있다(다음 보내기가 BOX_NOT_EMPTY로 막힘) — 지운 뒤 다시 읽어 0자가 될 때까지 최대 4번
  const wipe = (b) => {
    if (!b) return null;
    for (let i = 0; i < 4; i++) {
      let cur = '';
      try { cur = norm(b.el.value()); } catch (e) { return null; }
      if (!cur.length) return 0;
      try { b.el.value = ''; } catch (e) {}
      delay(0.4);
    }
    try { return norm(b.el.value()).length; } catch (e) { return null; }
  };
  const closeReply = () => {
    const r = { hadPanel: !!header() };
    const b = box();
    if (!r.hadPanel) {
      try { r.boxEmpty = b ? norm(b.el.value()) === '' : null; } catch (e) { r.boxEmpty = null; }
      return r;
    }
    r.wipeLeft = wipe(b);
    const c = closeBtn();
    if (!c) { r.closed = false; r.err = 'NO_CLOSE_BUTTON'; return r; }
    try { c.actions.byName('AXPress').perform(); } catch (e) {}
    for (let i = 0; i < 12 && header(); i++) delay(0.25);
    r.closed = !header();
    const b2 = box();
    r.boxDesc = b2 ? b2.desc : null;
    if (b2) wipe(b2);
    try { r.boxEmpty = b2 ? norm(b2.el.value()) === '' : null; } catch (e) { r.boxEmpty = null; }
    try { r.boxLen = b2 ? norm(b2.el.value()).length : null; } catch (e) { r.boxLen = null; }
    return r;
  };
  // 원글 찾느라 올린 화면을 맨 아래로 돌려놓는다 — 위로 올라간 채 두면 다음 답장 때 최신 글이 표에 없다
  const toBottom = () => { try { const sb = w.scrollAreas()[0].scrollBars()[0]; if (sb.value() < 0.999) { sb.value = 1; delay(0.5); return true; } } catch (e) {} return false; };
  const searchBtn = () => { try { return w.buttons().find((b) => { try { return b.description() === '검색'; } catch (e) { return false; } }) || null; } catch (e) { return null; } };
  const searchField = () => { try { return w.textFields().find((f) => { try { return /검색/.test(String(f.description())); } catch (e) { return false; } }) || null; } catch (e) { return null; } };
  // 돋보기 검색 칸을 닫고, 검색으로 옛 글 묶음만 불러온 표를 「최하단으로」로 최신 글까지 되돌린다 — 그대로 두면 다음 답장 때 최신 글이 표에 없다
  const restore = () => {
    const r = {};
    try { if (searchField()) { const b = searchBtn(); if (b) { b.actions.byName('AXPress').perform(); delay(0.6); } r.searchClosed = !searchField(); } } catch (e) {}
    try { const lb = w.buttons().find((b) => { try { return b.description() === '최하단으로'; } catch (e) { return false; } }); if (lb) { lb.actions.byName('AXPress').perform(); delay(1.5); r.latest = true; } } catch (e) {}
    r.scrolledToBottom = toBottom();
    return r;
  };
  const failClose = (o) => { out.cleanup = closeReply(); out.restore = restore(); return done(o); };

  try {
    if (mode === 'restore') return done({ ok: true, step: 'RESTORED', restore: restore() });
    if (mode === 'close') {
      const r = closeReply();
      Object.assign(r, restore());
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
    const want = norm(target.text || '');
    const isMedia = target.kind === 'media';
    const needCtx = isMedia || target.dup === true;
    const ctxB = Array.isArray(target.before) ? target.before : [];
    const ctxA = Array.isArray(target.after) ? target.after : [];
    const K = 5;
    // 긴 글은 말풍선에 앞부분만 보일 수 있다 — 100자 넘게 보이는 앞부분이 DB 글 앞부분과 같으면 같은 글
    const textEq = (tv, dv) => { const a = norm(tv); const b = norm(dv); if (a === b) return true; const cut = a.replace(/\s*(…|\.\.\.)?\s*(전체보기)?\s*$/, ''); return cut.length >= 100 && b.startsWith(cut); };
    const sigEq = (t, s) => (s === 'M' ? t.k === 'M' : (t.k === 'T' && String(s).startsWith('T:') && textEq(t.v, String(s).slice(2))));
    // 표의 행을 글(T)·사진/동영상/파일(M)로 읽는다 — 날짜 줄 등 둘 다 아닌 행은 뺀다(DB 쪽도 같은 기준으로 뺐다)
    const items = () => {
      let vals = null; let btns = null;
      try { vals = tb.rows.uiElements.textAreas.value(); } catch (e) { vals = null; }
      if (!vals) return null;
      if (needCtx) { try { btns = tb.rows.uiElements.buttons.description(); } catch (e) { btns = null; } }
      const list = [];
      vals.forEach((cells, i) => {
        let it = null;
        (cells || []).forEach((tas, c) => (tas || []).forEach((v, j) => { if (!it) it = { k: 'T', v: norm(v), path: [i, c, j] }; }));
        if (!it && btns && btns[i]) (btns[i] || []).forEach((ds, c) => { if (!it && (ds || []).some((x) => String(x) === '공유')) it = { k: 'M', path: [i, c] }; });
        if (it) list.push(it);
      });
      return list;
    };
    const scan = () => {
      const list = items();
      if (!list) return { hits: [], rows: 0 };
      const cands = [];
      list.forEach((t, x) => { if (isMedia ? t.k === 'M' : (t.k === 'T' && t.v === want)) cands.push(x); });
      if (!needCtx) return { hits: cands.map((x) => list[x].path), rows: list.length };
      // 앞뒤 글 맞추기: 볼 수 있는 앞뒤(최대 5개)가 전부 DB와 같고, 합쳐 2개 이상 맞은 자리만 그 글로 본다
      const ok = []; const scores = [];
      cands.forEach((x) => {
        let b = 0; while (b < K && b < ctxB.length && x - 1 - b >= 0 && sigEq(list[x - 1 - b], ctxB[b])) b++;
        let a = 0; while (a < K && a < ctxA.length && x + 1 + a < list.length && sigEq(list[x + 1 + a], ctxA[a])) a++;
        scores.push([x, b, a]);
        if (b === Math.min(K, ctxB.length, x) && a === Math.min(K, ctxA.length, list.length - 1 - x) && b + a >= Math.min(2, ctxB.length + ctxA.length)) ok.push(x);
      });
      return { hits: ok.map((x) => list[x].path), rows: list.length, cands: cands.length, scores: scores.slice(0, 8) };
    };
    const search = (qs) => {
      const b0 = searchBtn();
      if (!b0) return 'NO_SEARCH_BUTTON';
      if (searchField()) { try { b0.actions.byName('AXPress').perform(); } catch (e) {} delay(0.8); }
      try { b0.actions.byName('AXPress').perform(); } catch (e) { return 'SEARCH_PRESS_FAILED'; }
      let f = null;
      for (let i = 0; i < 8 && !f; i++) { delay(0.25); f = searchField(); }
      if (!f) return 'NO_SEARCH_FIELD';
      try { f.value = qs; } catch (e) { return 'SEARCH_SET_FAILED'; }
      delay(0.5);
      try { f.actions.byName('AXConfirm').perform(); } catch (e) { return 'SEARCH_CONFIRM_FAILED'; }
      return null;
    };
    const sb = (() => { try { return sa0.scrollBars()[0]; } catch (e) { return null; } })();
    let s = scan();
    // 창이 위로 올라가 있으면 표에 최신 글이 없다 — 맨 위로 가기 전에 먼저 맨 아래로 내려 다시 본다(바쁜 방의 몇 분 전 글)
    if (!s.hits.length && sb) {
      let v = 1;
      try { v = sb.value(); } catch (e) {}
      if (v < 0.999 || s.rows < 5) {
        try { sb.value = 1; } catch (e) {}
        delay(1);
        s = scan();
        out.bottomFirst = true;
      }
    }
    // 오래된 글: 돋보기(대화 내 검색)로 그 글 근처를 불러온다 — 안 되면 최신 글로 돌려놓고 아래 맨 위 넘기기로 간다.
    // 표가 너무 커서 원글을 화면 가운데로 못 옮길 때(아래 TARGET_NOT_VISIBLE)도 한 번 검색해 작은 묶음에서 다시 한다.
    let searched = false;
    const doSearch = () => {
      if (searched || !target.search) return false;
      searched = true;
      const err = search(String(target.search));
      out.search = err || 'OK';
      if (!err) for (let i = 0; i < 12; i++) { delay(0.5); s = scan(); if (s.hits.length) break; }
      if (!s.hits.length) { out.searchMiss = { rows: s.rows, cands: s.cands, scores: s.scores }; out.restore1 = restore(); s = scan(); }
      return true;
    };
    if (!s.hits.length) doSearch();
    let pages = 0;
    while (!s.hits.length && sb && pages < 5) {
      // 스크롤 막대 값 0 = 맨 위. 맨 위로 가면 카톡이 이전 기록을 더 불러온다
      try { sb.value = 0; } catch (e) { break; }
      pages++;
      delay(1);
      s = scan();
    }
    out.rows = s.rows; out.pages = pages; out.hitCount = s.hits.length;
    if (needCtx) out.ctx = { cands: s.cands, scores: s.scores };
    if (!s.hits.length) return done({ step: 'TARGET_NOT_ON_SCREEN' });
    if (s.hits.length > 1) return done({ step: 'TARGET_AMBIGUOUS', hits: s.hits });
    // 스크롤 막대 값 = (말풍선 위 - 표 위 + 말풍선 높이/2 - 영역 높이/2) / (표 높이 - 영역 높이)
    // 사진·동영상·파일은 글칸이 없다 — 행의 칸(AXCell, AXShowMenu 있음)에 메뉴를 연다
    const pick = (hit) => (isMedia ? tb.rows[hit[0]].uiElements[hit[1]] : tb.rows[hit[0]].uiElements[hit[1]].textAreas[hit[2]]);
    let bubble = null;
    let moves = 0;
    for (let attempt = 0; ; attempt++) {
    if (attempt >= 3) return done({ step: 'TARGET_MOVED', attempts: attempt });
    const hit = s.hits[0];
    bubble = pick(hit);
    const [saY, saH] = [sa0.position()[1], sa0.size()[1]];
    const visible = () => { const y = bubble.position()[1]; const h = bubble.size()[1]; const cy = y + h / 2; return (cy >= saY && cy <= saY + saH) || (y <= saY && y + h >= saY + saH); };
    // 표가 커지면(수백~천 줄) 막대 값과 표 높이가 비례하지 않아 위 계산이 계속 빗나간다.
    // 첫 번째는 위 계산으로 옮기고, 그다음부터는 방금 움직인 거리(표 y 변화 ÷ 막대 값 변화)로 남은 거리를 나눠 다시 옮긴다(최대 8번).
    let m = 0;
    let shown = true;
    let pxPerUnit = null;
    while (!visible()) {
      if (!sb || m >= 8) { shown = false; break; }
      const ty = tb.position()[1]; const th = tb.size()[1];
      const cur = sb.value();
      const need = (saY + saH / 2) - (bubble.position()[1] + bubble.size()[1] / 2);
      const next = pxPerUnit === null
        ? ((bubble.position()[1] - ty) + bubble.size()[1] / 2 - saH / 2) / Math.max(1, th - saH)
        : cur + need / pxPerUnit;
      try { sb.value = Math.max(0, Math.min(1, next)); } catch (e) { return done({ step: 'SCROLL_FAILED', err: String(e).slice(0, 120) }); }
      m++;
      delay(0.5);
      const dv = sb.value() - cur; const dy = tb.position()[1] - ty;
      if (Math.abs(dv) > 1e-6 && dy !== 0) pxPerUnit = dy / dv;
    }
    moves += m;
    if (!shown) {
      if (doSearch() && s.hits.length === 1) continue;
      return done({ step: 'TARGET_NOT_VISIBLE', moves });
    }
    // 옮기는 동안 카톡이 위쪽 기록을 더 불러오면 행 번호가 밀린다 — 다시 찾아 같은 자리인지 본다
    // (시험에서 밀린 번호로 사진 대신 파일 말풍선을 열었다 — 인용 검사가 막았다)
    const s2 = scan();
    if (s2.hits.length === 1 && s2.hits[0].join() === hit.join()) break;
    out.shifted = (out.shifted || 0) + 1;
    s = s2;
    if (s.hits.length !== 1) return done({ step: s.hits.length ? 'TARGET_AMBIGUOUS' : 'TARGET_MOVED', hits: s.hits });
    }
    out.moves = moves;
    if (!isMedia && norm(bubble.value()) !== want) return done({ step: 'TARGET_MOVED' });

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
    if (isMedia) out.quotes = quotes.map((q) => q.slice(0, 40));
    const fw = flat(want);
    const fl = flat(want.split('\n')[0]);
    // 사진·동영상·파일 인용은 「사진」·「파일: <파일 이름>」처럼 보인다 — quotes 힌트 중 하나가 들어 있어야 한다
    const hints = (Array.isArray(target.quotes) ? target.quotes : []).map(flat).filter((x) => x.length);
    // 인용은 첫 줄만 보이고 「…」로 잘릴 수 있다 — 앞 10자 이상이 원글 앞부분과 같거나, 인용이 원글 첫 줄 전체와 같으면 같은 글로 본다
    // (첫 줄이 10자보다 짧은 여러 줄 글은 앞 10자 규칙만으로는 늘 틀렸다)
    const quoteOk = isMedia ? quotes.some((q) => hints.some((hv) => flat(q).indexOf(hv) >= 0)) : quotes.some((q) => { const fq = flat(q).replace(/(…|\.\.\.)$/, '').trim(); return fq === fw || (fq.length >= Math.min(10, fw.length) && fw.startsWith(fq)) || (fq.length > 0 && fq === fl); });
    if (!quoteOk) return failClose({ step: 'REPLY_TARGET_MISMATCH', why: 'quote' });
    const author = String(target.author || '');
    const headerOk = h === author + '에게 ' + kind || (target.self === true && h === '나에게 ' + kind);
    if (!headerOk) return failClose({ step: 'REPLY_TARGET_MISMATCH', why: 'header', author });

    const b = box();
    if (!b || b.desc !== kind + ' 메시지 입력') return failClose({ step: 'NO_REPLY_BOX', desc: b ? b.desc : null });
    if (norm(b.el.value()).length) return failClose({ step: 'BOX_NOT_EMPTY_AFTER_REPLY' });
    if (mode === 'open') return done({ ok: true, step: 'REPLY_OPEN' });

    b.el.value = msg;
    if (fault() === 'partial') { delay(0.3); b.el.value = msg.slice(0, 14); }
    let got = '';
    for (let i = 0; i < 4; i++) { delay(0.5); got = norm(b.el.value()); if (got === norm(msg)) break; }
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
    out.restore = restore();
    return done({ ok: true, step: 'PRESSED' });
  } catch (e) {
    return failClose({ step: 'AX_ERROR', err: String(e).slice(0, 200) });
  }
}

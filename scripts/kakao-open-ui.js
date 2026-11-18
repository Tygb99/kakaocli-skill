// 카카오톡 본창 채팅 목록에서 닫힌 채팅 창을 연다. 마우스·클립보드를 쓰지 않고 카톡을 앞으로 띄우지 않는다
// (System Events 접근성 + Return 키 하나를 카톡 PID에만).
// 사용: osascript -l JavaScript kakao-open-ui.js <창 제목> <find|open> [hint] [via] [side] [near]
//  find : 목록에서 그 방 줄을 찾기까지만 한다(메뉴를 열지 않는다)
//  open : 창을 연다. 그 제목의 창이 이미 있으면 아무것도 누르지 않고 ALREADY_OPEN
//  hint : 같은 이름의 방 줄이 여럿일 때, 줄의 미리보기 글이나 줄 배지 설명에 든 말로 하나를 고른다.
//         나와의 채팅 줄 이름은 내 이름이라 내 오픈프로필 줄과 겹친다 — 배지가 나와의 채팅은 「badge me」,
//         오픈채팅은 「badge openchat room」이므로 hint 「badge me」로 나와의 채팅을 고른다.
//  via  : 오픈프로필로 온 1:1 대화. 본창 줄 이름은 내 오픈프로필 이름(via)이고, 그 줄의 「채팅방 열기」는 대화 창이 아니라
//         제목 없는 「오픈프로필 대화 목록」 창을 연다. 진짜 대화 창 제목은 상대 이름(<창 제목>)이라 목록 창의 상대 줄을 한 번 더 연다.
//  side : 「오픈채팅 목록 분리」가 켜져 있을 때 그 방이 있는 쪽(open|chat). 주면 그쪽부터 찾는다(kakao-send.py가 DB linkId로 정해 넘긴다).
//  near : 그 방이 그쪽 목록에서 몇 번째 줄쉼인지(0부터, 쉼표로 여럿). 주면 그 근처 줄만 읽어 찾고, 못 찾으면 예전처럼 목록을 다 읽는다
//         (kakao-send.py가 DB 순서로 세어 넘긴다 — 목록을 다 읽으면 655줄에 약 80초, 근처만 읽으면 1초 안팎).
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 순서(실측): 메뉴 「창 → 채팅」 AXPress(본창을 채팅 탭으로) → 본창 목록에서 첫 글자칸이 창 제목과 같은 줄을 찾는다
//   → 카톡 설정 「오픈채팅 목록 분리」(DB NTSetting `openchatlist_issperated`)가 켜져 있으면 채팅 탭에 「채팅」·「오픈채팅」 단추가 있고
//     두 쪽 중 한쪽 목록만 보인다. side 쪽(없으면 지금 쪽)에서 먼저 찾고, 없으면 다른 쪽 단추를 AXPress해 한 번 더 찾는다.
//     끝나면(열었든 못 찾았든) 처음 쪽으로 되돌린다(출력 listSide·listSwitched·listRestored).
//     분리가 꺼져 있으면 「오픈채팅」 단추 없이 한 목록에 다 있어 누르지 않는다(listSide 「none」).
//     보이는 쪽은 목록 이름 옆 ▼ 그림(설명 「common icon triangledown …」)의 x로 판정한다 — 「오픈채팅」 단추보다 오른쪽이면 오픈채팅.
//     단추의 AXHelp(「채팅 목록 전환」)는 목록을 바꿔도 그대로 남을 때가 있어 쓰지 않는다(2026-11-18 실측).
//   → 그 줄을 선택하고 Return을 카톡 PID에만 보낸다(rowReturnOpen) → 그 제목의 창이 생겼는지 확인. 각 단계는 한 번만 누른다.
//   → 선택·초점 확인이 안 되면 우클릭 메뉴 길: 줄이 보이는 영역 밖이면 세로 스크롤 막대 값을 바꿔 가운데로 옮기고
//     (화면 밖 줄은 AXShowMenu에 반응이 없다) 그 줄 셀에 AXShowMenu → 「채팅방 열기」 AXPress.
//     이 길은 본창을 사용자가 보던 창 위로 올린다(출력 how·returnSkipped).
//   → 어느 길이든 끝날 때 카톡 창이 맨 위에 올라와 있으면 맨 앞 앱의 초점 창을 다시 맨 위로 올려 놓는다(restoreFront, 출력 frontRaised).
// 열면 그 방의 안 읽은 글이 읽음 처리된다(상대 화면의 숫자 1이 사라진다). 남의 1:1 방을 시험으로 열지 않는다.
// 창·메뉴 이름(카카오톡, 창, 채팅, 채팅방 열기)은 한국어 UI에서 확인한 값이다.
// 출력: 한 줄 JSON {ok, step, front0, front1, ...}
ObjC.import('Foundation');
ObjC.import('CoreGraphics');

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

function frontName(se) {
  try { return se.processes.whose({ frontmost: true })()[0].name(); } catch (e) { return null; }
}

function waitFor(fn, tries, step) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; delay(step || 0.25); }
  return null;
}

// 본창 목록의 줄을 선택하고 Return을 카톡 PID에만 보내 연다(카톡을 앞으로 띄우지 않는다).
// PID로 보낸 키는 그 앱의 주 창·초점 요소로 간다. 채팅 창 입력칸에 들어가면 치던 글이 보내질 수 있어, 선택된 줄이 그 방 하나이고
// 본창이 주 창이며 초점이 본창 목록에 있는 것을 확인한 뒤에만 보낸다. 하나라도 아니면 키를 보내지 않고 그 이유를 돌려준다.
function rowReturnOpen(se, p, main, list, row, title) {
  const nfc = (s) => String(s).normalize('NFC');
  // 선택된 줄 전체(줄을 다 훑어 고르라 수백 줄에 0.4초쯤) — 키를 보내기 직전에 한 번만 본다. 표의 AXSelectedRows는 JXA로 안 읽힌다.
  const picked = () => { try { return list.rows.whose({ selected: true })().map((r) => { try { return nfc(r.uiElements[0].staticTexts[0].value()); } catch (e) { return ''; } }); } catch (e) { return []; } };
  const only = () => { const s = picked(); return s.length === 1 && s[0] === nfc(title); };
  try { row.selected = true; } catch (e) { return { step: 'NO_SELECT' }; }
  if (!waitFor(() => { try { return row.selected() === true; } catch (e) { return false; } }, 10, 0.1)) return { step: 'SELECT_NOT_CONFIRMED' };
  const isMain = () => { try { return main.attributes.byName('AXMain').value() === true; } catch (e) { return false; } };
  if (!isMain()) { try { main.attributes.byName('AXMain').value = true; } catch (e) {} }
  try { list.focused = true; } catch (e) {}
  const focused = () => {
    try {
      const role = p.attributes.byName('AXFocusedUIElement').value().role();
      return isMain() && p.attributes.byName('AXFocusedWindow').value().name() === '카카오톡' && ['AXTable', 'AXOutline', 'AXRow', 'AXCell'].indexOf(role) >= 0;
    } catch (e) { return false; }
  };
  if (!waitFor(focused, 10, 0.1)) return { step: 'FOCUS_NOT_CONFIRMED' };
  // 본창을 주 창·초점으로 만드는 사이 본창이 보던 창 위로 올라올 때가 있다 — 창이 열릴 때까지 그대로 두지 않고 여기서 한 번 되돌린다
  restoreFront(se, p);
  if (!only()) return { step: 'SELECT_CHANGED' };
  const pid = p.unixId();
  for (const down of [true, false]) $.CGEventPostToPid(pid, $.CGEventCreateKeyboardEvent($(), 36, down)); // 36 = Return
  return { step: 'PRESSED' };
}

// 창을 여는 동안 카톡 본창·새 창이 사용자가 보던 창 위로 올라올 때가 있다. 우클릭 메뉴는 늘 본창을 올리고, 줄 선택 → Return도
// 맨 앞 앱에 따라 다르다(2026-11-18: Discord가 앞일 때 올라왔고 Ghostty·Aside가 앞일 때는 아래에 머물렀다).
// 끝나는 순간 화면 맨 위 보통 창이 카톡 것이고 카톡이 맨 앞 앱이 아니면, 그 순간 맨 앞 앱의 초점 창을 다시 맨 위로 올린다.
// 시작할 때 창을 잡아 두지 않는다 — 그사이 사용자가 앱을 바꾸면 낡은 창을 올려 도리어 보던 창을 가린다(같은 날 실측).
// 돌려주는 값: true = 올려 놓음, false = 보던 창이 그대로 맨 위, null = 카톡이 맨 앞 앱이거나 확인하지 못함.
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

function rowMenuOpen(cell) {
  cell.actions.byName('AXShowMenu').perform();
  const menu = waitFor(() => { try { return cell.menus.length ? cell.menus[0] : null; } catch (e) { return null; } }, 12);
  if (!menu) return { step: 'NO_ROW_MENU' };
  const items = menu.menuItems();
  const openItem = items.find((m) => { try { return m.name() === '채팅방 열기'; } catch (e) { return false; } });
  if (!openItem) {
    const menuItems = items.map((m) => { try { return String(m.name()); } catch (e) { return ''; } });
    try { menu.actions.byName('AXCancel').perform(); } catch (e) {}
    return { step: 'NO_OPEN_ITEM', menuItems };
  }
  openItem.actions.byName('AXPress').perform();
  return { step: 'PRESSED' };
}

function profileRows(p, title) {
  // 제목 없는 창 가운데 표 줄 첫 글자칸이 title인 줄을 모두 찾는다(오픈프로필 대화 목록 창).
  const hits = [];
  let wins = [];
  try { wins = p.windows(); } catch (e) { return hits; }
  for (const w of wins) {
    let n = null;
    try { n = w.name(); } catch (e) { continue; }
    if (n !== '') continue;
    let rows = [];
    try { rows = w.scrollAreas[0].tables[0].rows(); } catch (e) { continue; }
    for (const r of rows) {
      try {
        const c = r.uiElements[0];
        const t = c.staticTexts.value();
        if (t.length && String(t[0]).normalize('NFC') === title.normalize('NFC')) hits.push({ c, texts: t.slice(0, 3).map((s) => String(s).slice(0, 30)) });
      } catch (e) {}
    }
  }
  return hits;
}

function run(argv) {
  const [title, mode, hint, via, side, nearArg] = argv;
  const nearRows = /^\d+(,\d+)*$/.test(nearArg || '') ? nearArg.split(',').map(Number) : [];
  const se = Application('System Events');
  const t0 = Date.now();
  const out = { ok: false, step: '', title, front0: frontName(se), ms: {} };
  const lap = (k) => { out.ms[k] = Date.now() - t0; }; // 단계별 누적 시간(ms)
  let restoreList = null; // 목록 쪽을 바꿨으면 처음 쪽으로 되돌리는 함수
  let app = null; // 본창을 건드리기 시작한 뒤의 카톡 프로세스 — 끝날 때 창 순서를 되돌릴지 본다
  const done = (o) => {
    Object.assign(out, o);
    if (restoreList) { const r = restoreList; restoreList = null; try { out.listRestored = r(); } catch (e) { out.listRestored = false; } }
    if (app) { const raised = restoreFront(se, app); app = null; if (raised !== null) out.frontRaised = raised; }
    out.front1 = frontName(se);
    lap('end');
    return JSON.stringify(out);
  };
  // openlist: via 길 안에서만 쓴다 — 본창 줄의 「채팅방 열기」까지만 누르고 그 제목의 창을 기다리지 않는다.
  if (mode !== 'find' && mode !== 'open' && mode !== 'openlist') return done({ step: 'BAD_MODE' });
  if (!title) return done({ step: 'NO_TITLE' });
  let phase = 'start';
  try {
    const k = kakaoProcess(se);
    if (k.err) return done(Object.assign({ step: k.err }, k));
    const p = k.p;
    const names = () => { try { return p.windows.name(); } catch (e) { return []; } };
    const nfc = (s) => String(s).normalize('NFC');
    const count = (t) => names().filter((n) => nfc(n) === nfc(t)).length;
    const same = count(title);
    if (same > 1) return done({ step: 'AMBIGUOUS_WINDOWS', count: same });
    if (same === 1) return done({ ok: true, step: 'ALREADY_OPEN' });
    if (via) {
      out.via = via;
      phase = 'via-list';
      let ph = profileRows(p, title);
      if (!ph.length) {
        const sub = JSON.parse(run([via, mode === 'find' ? 'find' : 'openlist', hint || '']));
        out.viaStep = sub.step;
        if (mode === 'find') return done({ ok: !!sub.ok, step: sub.ok ? 'FOUND_VIA' : sub.step, viaRow: sub.rowTexts });
        if (!sub.ok) return done({ step: 'VIA_' + sub.step });
        ph = waitFor(() => { const h = profileRows(p, title); return h.length ? h : null; }, 16) || [];
      }
      if (ph.length !== 1) return done({ step: ph.length ? 'AMBIGUOUS_PROFILE_ROW' : 'NOT_IN_PROFILE_LIST', count: ph.length });
      out.profileRow = ph[0].texts;
      if (mode === 'find') return done({ ok: true, step: 'FOUND_IN_PROFILE_LIST' });
      phase = 'via-menu';
      const r = rowMenuOpen(ph[0].c);
      if (r.step !== 'PRESSED') return done(r);
      const opened = waitFor(() => count(title) === 1, 24);
      return done({ ok: !!opened, step: opened ? 'OPENED' : 'NOT_OPENED_AFTER_PRESS' });
    }

    app = p;
    phase = 'tab';
    const winMenu = p.menuBars[0].menuBarItems.byName('창').menus[0];
    const chatItem = winMenu.menuItems().find((m) => { try { return m.name() === '채팅'; } catch (e) { return false; } });
    if (!chatItem) return done({ step: 'NO_CHAT_MENU_ITEM' });
    chatItem.actions.byName('AXPress').perform();
    const main = waitFor(() => {
      const w = p.windows().find((x) => { try { return x.name() === '카카오톡'; } catch (e) { return false; } });
      if (!w) return null;
      try { if (w.staticTexts.value().indexOf('채팅') >= 0) return w; } catch (e) {}
      // 채팅 탭 머리글이 글자칸이 아니라 단추(설명 「채팅」)로 나오는 화면도 있다(2026-11-11 실측: 글자칸은 안 읽은 수 하나뿐). 「채팅방 추가」 단추는 채팅 탭에만 있다.
      try { const d = w.buttons.description(); return (d.indexOf('채팅') >= 0 && d.indexOf('채팅방 추가') >= 0) ? w : null; } catch (e) { return null; }
    }, 20);
    if (!main) return done({ step: 'NO_CHAT_TAB' });
    lap('tab');

    phase = 'rows';
    const list = main.scrollAreas[0].uiElements[0];
    let texts = [];
    let rowCount = 0;
    // 미리보기 글은 정적 글자가 아니라 줄 안 글칸(textArea)에 있다. hint는 줄의 나머지 글자칸·미리보기·배지 설명에 맞춰 본다.
    const preview = (i) => { try { return list.rows[i].uiElements[0].scrollAreas[0].textAreas[0].value() || ''; } catch (e) { return ''; } };
    const badges = (i) => { try { return list.rows[i].uiElements[0].images.description().map(String); } catch (e) { return []; } };
    const hinted = (i, t) => t.slice(1).concat([preview(i)], badges(i)).some((x) => nfc(x).indexOf(nfc(hint)) >= 0);
    // 빠른 길: 줄을 다 읽지 않고(655줄에 약 80초 — 카톡이 화면 밖 줄 내용을 내주는 것이 느리다), kakao-send.py가 DB 순서로 짐작한
    // 줄 번호(near) 근처만 한 줄씩 읽는다. 줄 하나 읽기는 화면 안 약 0.03초, 화면 밖 0.1~0.4초다(2026-11-18 실측).
    // 앱 목록 순서와 DB 순서를 맞춰 보니 이름이 하나뿐인 방 539개 중 514개가 줄 번호까지 같고 가장 큰 차이가 14줄이었다
    // (최근 순으로만 센 값 — 어긋난 곳은 안 읽은 방이 먼저 오는 맨 위 20여 줄이라, 지금은 그 경우의 줄 번호도 같이 받는다).
    // 짐작한 줄에서 위아래로 넓혀 가며 찾고, 찾은 줄 위아래에 이름이 같은 줄이 또 있으면 쓰지 않는다(예전 길이 AMBIGUOUS로 가린다).
    // 짐작은 여럿일 수 있다(목록 정렬이 「안 읽은 방 먼저」인지 「최근 순」인지는 DB 설정 표에 값이 없어 둘 다 넘겨받는다) — 각 짐작에서 같은 거리씩 번갈아 넓힌다.
    const NEAR = 20, NEAR_MORE = 2;
    const findNear = (guesses) => {
      let n = 0;
      try { n = list.rows.length; } catch (e) { return null; }
      if (!n) return null;
      rowCount = n;
      const gs = guesses.map((g) => Math.min(n - 1, Math.max(0, g)));
      const seen = {};
      let read = 0;
      const match = (i) => {
        if (i < 0 || i >= n || seen[i]) return false;
        seen[i] = true;
        let t = null;
        try { t = list.rows[i].uiElements[0].staticTexts.value(); } catch (e) { t = null; }
        read++;
        return !!t && !!t.length && nfc(t[0]) === nfc(title) && (!hint || hinted(i, t));
      };
      let hit = -1;
      for (let d = 0; d <= NEAR && hit < 0; d++) {
        for (const g of gs) for (const i of d ? [g - d, g + d] : [g]) if (hit < 0 && match(i)) hit = i;
      }
      // 짐작한 바로 그 줄이 아니라 넓혀서 찾았으면, 위아래 NEAR_MORE줄에 같은 이름이 또 있는지 본다(있으면 줄 번호만으로는 못 가린다).
      // hint가 있으면 그 줄이 hint까지 맞은 것이라 보지 않는다.
      let twin = false;
      const exact = hit >= 0 && gs.indexOf(hit) >= 0;
      for (let d = 1; hit >= 0 && !exact && !hint && d <= NEAR_MORE; d++) for (const i of [hit - d, hit + d]) if (match(i)) twin = true;
      out.near = { guess: gs, read, hits: hit < 0 ? 0 : twin ? 2 : 1 };
      return hit >= 0 && !twin ? [hit] : null;
    };
    // 느린 길: 한 번에 다 읽는다(줄마다 따로 읽으면 더 느리다).
    // 목록을 못 읽었거나 비었으면 기다린다. 줄이 있는데 이름이 없으면 한 번만 더 읽고 그쪽엔 없다고 본다
    // (한 번 읽기가 49줄에도 수 초라, 없는 쪽을 12번 읽으면 1분을 넘긴다 — 2026-11-18 실측 85초).
    const findRows = () => {
      let seen = 0;
      for (let i = 0; i < 12; i++) {
        try { texts = list.rows.uiElements[0].staticTexts.value(); } catch (e) { texts = []; }
        if (texts.length) {
          const hits = [];
          texts.forEach((t, j) => { if (t && t.length && nfc(t[0]) === nfc(title)) hits.push(j); });
          if (hits.length) return hits;
          if (++seen >= 2) return null;
        }
        delay(0.25);
      }
      return null;
    };
    const sideBtn = (s) => main.buttons.whose({ description: s === 'open' ? '오픈채팅' : '채팅' })[0];
    const listSide = () => {
      try {
        const tri = main.images().find((i) => { try { return String(i.description()).indexOf('common icon triangledown') === 0; } catch (e) { return false; } });
        if (!tri) return '';
        return tri.position()[0] > sideBtn('open').position()[0] ? 'open' : 'chat';
      } catch (e) { return ''; }
    };
    const showSide = (s) => { sideBtn(s).actions.byName('AXPress').perform(); return !!waitFor(() => listSide() === s, 20); };
    const was = listSide();
    out.listSide = was || 'none';
    const order = !was ? [''] : (side === 'open' || side === 'chat') && side !== was ? [side, was] : [was, was === 'open' ? 'chat' : 'open'];
    let found = null;
    for (const s of order) {
      if (s && s !== listSide()) {
        phase = 'list-side';
        if (!showSide(s)) return done({ step: 'LIST_NOT_SWITCHED', rowCount });
        out.listSwitched = s;
        restoreList = s === was ? null : () => showSide(was);
        phase = 'rows';
      }
      // 짐작한 줄 번호는 그 방이 있는 쪽 목록 기준이다(분리가 꺼져 있으면 한 목록 기준)
      if (nearRows.length && (!s || s === side)) found = findNear(nearRows);
      if (found) { if (hint) out.hint = hint; break; }
      found = findRows();
      rowCount = texts.length;
      if (found) break;
    }
    out.rowCount = rowCount;
    lap('find');
    if (!found) return done({ step: 'NOT_IN_LIST' });
    if (found.length > 1 && hint) {
      const narrowed = found.filter((i) => hinted(i, texts[i]));
      if (narrowed.length === 1) { out.hint = hint; found.splice(0, found.length, narrowed[0]); }
    }
    if (found.length > 1) return done({ step: 'AMBIGUOUS', rows: found });
    out.row = found[0];
    if (mode === 'find') return done({ ok: true, step: 'FOUND' });

    const row = list.rows[found[0]];
    const before = names().map(nfc);
    // 여는 길 1: 줄을 선택하고 Return(목록에서 한 번 클릭 → Return과 같은 길). 화면 밖 줄도 선택되어 스크롤이 필요 없고,
    // 본창이 다른 앱 창 위로 올라오지 않는다. 길 2(우클릭 메뉴)는 메뉴를 띄우는 순간 본창이 맨 앞 앱 창 위로 올라온다(2026-11-18 실측).
    phase = 'return';
    const viaReturn = rowReturnOpen(se, p, main, list, row, title);
    out.how = viaReturn.step === 'PRESSED' ? 'return' : 'menu';
    lap('pressed');
    if (viaReturn.step !== 'PRESSED') out.returnSkipped = viaReturn.step;
    else if (mode === 'openlist') return done({ ok: true, step: 'PRESSED_LIST' });
    else {
      if (waitFor(() => count(title) >= 1, 60, 0.1)) { lap('opened'); return done({ ok: true, step: 'OPENED' }); }
      const extra = names().map(nfc).filter((n) => n && before.indexOf(n) < 0);
      return done({ step: extra.length ? 'OPENED_OTHER_WINDOW' : 'NOT_OPENED_AFTER_PRESS', other: extra });
    }

    phase = 'scroll';
    const sa = main.scrollAreas[0];
    // AX가 주는 y·높이는 16비트로 접혀 나온다 — 표가 32767px(74px 줄로 약 440줄)를 넘으면 음수·엉뚱한 값이 된다
    // (2026-11-18 704줄 목록: 표 높이 -13438, 마지막 줄 y -13162). 그래서 두 값의 차이를 65536으로 펴서 쓴다.
    const M = 65536;
    const below = (a, b) => (((a - b) % M) + M) % M; // a가 b보다 아래(0 이상)일 때의 진짜 거리
    const near = (d) => below(d + M / 2, 0) - M / 2; // 화면 근처 거리(±32768 안)
    const top = sa.position()[1], saH = sa.size()[1];
    const visible = () => { const d = near(row.position()[1] - top); return d >= 0 && d + row.size()[1] <= saH; };
    if (!visible()) {
      const bar = sa.scrollBars().find((b) => { try { return b.orientation() === 'AXVerticalOrientation'; } catch (e) { return false; } });
      if (!bar) return done({ step: 'ROW_HIDDEN_NO_SCROLLBAR' });
      const last = list.rows[rowCount - 1];
      const listY = list.position()[1];
      const span = below(last.position()[1], listY) + last.size()[1] - saH;
      const off = below(row.position()[1], listY) - saH / 2 + row.size()[1] / 2;
      const clamp = (v) => Math.min(1, Math.max(0, v));
      // 첫 계산이 빗나가면 방금 움직인 거리(표 y 변화 ÷ 막대 값 변화)로 남은 거리를 나눠 최대 8번 다시 옮긴다.
      let prevV = Number(bar.value()), prevY = listY;
      bar.value = clamp(off / span);
      for (let i = 0; i < 8 && !waitFor(visible, 4); i++) {
        const nowV = Number(bar.value()), nowY = list.position()[1];
        const moved = nowV > prevV ? below(prevY, nowY) : nowV < prevV ? -below(nowY, prevY) : 0;
        const perUnit = nowV !== prevV ? moved / (nowV - prevV) : 0;
        if (!perUnit) break;
        const miss = near(row.position()[1] + row.size()[1] / 2 - (top + saH / 2));
        prevV = nowV; prevY = nowY;
        bar.value = clamp(nowV + miss / perUnit);
      }
      if (!waitFor(visible, 4)) return done({ step: 'ROW_HIDDEN_AFTER_SCROLL' });
      // 스크롤이 멈춘 뒤에 누른다 — 줄 y를 0.3초 간격으로 두 번 읽어 같고 보이는 자리여야 한다.
      const settled = waitFor(() => { const y0 = row.position()[1]; delay(0.3); return y0 === row.position()[1] && visible(); }, 10);
      if (!settled) return done({ step: 'ROW_NOT_SETTLED' });
      out.scrolled = true;
    }

    phase = 'menu';
    // 누르기 직전에 그 자리 줄이 여전히 그 방인지 본다(새 글이 오면 목록 순서가 바뀐다).
    try { if (nfc(row.uiElements[0].staticTexts[0].value()) !== nfc(title)) return done({ step: 'ROW_MOVED' }); } catch (e) { return done({ step: 'ROW_MOVED' }); }
    const r = rowMenuOpen(row.uiElements[0]);
    if (r.step !== 'PRESSED') return done(r);
    if (mode === 'openlist') return done({ ok: true, step: 'PRESSED_LIST' });
    const opened = waitFor(() => count(title) >= 1, 24);
    if (opened) return done({ ok: true, step: 'OPENED' });
    // 다른 방 창이 열렸으면 이름을 알린다(2026-11-18 704줄 목록에서 스크롤 뒤 누른 때 다른 방 창이 열린 일이 있다).
    const extra = names().map(nfc).filter((n) => n && before.indexOf(n) < 0);
    return done({ step: extra.length ? 'OPENED_OTHER_WINDOW' : 'NOT_OPENED_AFTER_PRESS', other: extra });
  } catch (e) {
    return done({ step: 'AX_ERROR', phase, err: String(e).slice(0, 200) });
  }
}

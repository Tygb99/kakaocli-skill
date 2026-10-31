// 카카오톡 본창 채팅 목록에서 닫힌 채팅 창을 연다. 키 입력·마우스·클립보드를 쓰지 않고 카톡을 앞으로 띄우지 않는다(System Events 접근성만).
// 사용: osascript -l JavaScript kakao-open-ui.js <창 제목> <find|open> [hint] [via]
//  find : 목록에서 그 방 줄을 찾기까지만 한다(메뉴를 열지 않는다)
//  open : 창을 연다. 그 제목의 창이 이미 있으면 아무것도 누르지 않고 ALREADY_OPEN
//  hint : 같은 이름의 방 줄이 여럿일 때, 줄의 미리보기 글이나 줄 배지 설명에 든 말로 하나를 고른다.
//         나와의 채팅 줄 이름은 내 이름이라 내 오픈프로필 줄과 겹친다 — 배지가 나와의 채팅은 「badge me」,
//         오픈채팅은 「badge openchat room」이므로 hint 「badge me」로 나와의 채팅을 고른다.
//  via  : 오픈프로필로 온 1:1 대화. 본창 줄 이름은 내 오픈프로필 이름(via)이고, 그 줄의 「채팅방 열기」는 대화 창이 아니라
//         제목 없는 「오픈프로필 대화 목록」 창을 연다. 진짜 대화 창 제목은 상대 이름(<창 제목>)이라 목록 창의 상대 줄을 한 번 더 연다.
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 순서(실측): 메뉴 「창 → 채팅」 AXPress(본창을 채팅 탭으로) → 본창 목록에서 첫 글자칸이 창 제목과 같은 줄을 찾는다
//   → 줄이 보이는 영역 밖이면 세로 스크롤 막대 값을 바꿔 가운데로 옮긴다(화면 밖 줄은 AXShowMenu에 반응이 없다)
//   → 그 줄 셀에 AXShowMenu → 「채팅방 열기」 AXPress → 그 제목의 창이 생겼는지 확인. 각 단계는 한 번만 누른다.
// 열면 그 방의 안 읽은 글이 읽음 처리된다(상대 화면의 숫자 1이 사라진다). 남의 1:1 방을 시험으로 열지 않는다.
// 창·메뉴 이름(카카오톡, 창, 채팅, 채팅방 열기)은 한국어 UI에서 확인한 값이다.
// 출력: 한 줄 JSON {ok, step, front0, front1, ...}
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

function frontName(se) {
  try { return se.processes.whose({ frontmost: true })()[0].name(); } catch (e) { return null; }
}

function waitFor(fn, tries) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; delay(0.25); }
  return null;
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
  const [title, mode, hint, via] = argv;
  const se = Application('System Events');
  const out = { ok: false, step: '', title, front0: frontName(se) };
  const done = (o) => { Object.assign(out, o); out.front1 = frontName(se); return JSON.stringify(out); };
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

    phase = 'tab';
    const winMenu = p.menuBars[0].menuBarItems.byName('창').menus[0];
    const chatItem = winMenu.menuItems().find((m) => { try { return m.name() === '채팅'; } catch (e) { return false; } });
    if (!chatItem) return done({ step: 'NO_CHAT_MENU_ITEM' });
    chatItem.actions.byName('AXPress').perform();
    const main = waitFor(() => {
      const w = p.windows().find((x) => { try { return x.name() === '카카오톡'; } catch (e) { return false; } });
      if (!w) return null;
      try { return w.staticTexts.value().indexOf('채팅') >= 0 ? w : null; } catch (e) { return null; }
    }, 20);
    if (!main) return done({ step: 'NO_CHAT_TAB' });

    phase = 'rows';
    // 줄마다 읽지 않고 한 번에 읽는다(줄마다 읽으면 수백 줄에 수십 초).
    const list = main.scrollAreas[0].uiElements[0];
    let texts = [];
    const found = waitFor(() => {
      try { texts = list.rows.uiElements[0].staticTexts.value(); } catch (e) { return null; }
      const hits = [];
      texts.forEach((t, i) => { if (t && t.length && nfc(t[0]) === nfc(title)) hits.push(i); });
      return hits.length ? hits : null;
    }, 12);
    out.rowCount = texts.length;
    if (!found) return done({ step: 'NOT_IN_LIST' });
    if (found.length > 1 && hint) {
      const h = nfc(hint);
      // 미리보기 글은 정적 글자가 아니라 줄 안 글칸(textArea)에 있다. 둘 다 본다.
      const preview = (i) => { try { return list.rows[i].uiElements[0].scrollAreas[0].textAreas[0].value() || ''; } catch (e) { return ''; } };
      const badges = (i) => { try { return list.rows[i].uiElements[0].images.description().map(String); } catch (e) { return []; } };
      const narrowed = found.filter((i) => texts[i].slice(1).concat([preview(i)], badges(i)).some((t) => nfc(t).indexOf(h) >= 0));
      if (narrowed.length === 1) { out.hint = hint; found.splice(0, found.length, narrowed[0]); }
    }
    if (found.length > 1) return done({ step: 'AMBIGUOUS', rows: found });
    out.row = found[0];
    if (mode === 'find') return done({ ok: true, step: 'FOUND' });

    phase = 'scroll';
    const sa = main.scrollAreas[0];
    const row = list.rows[found[0]];
    const visible = () => {
      const y = row.position()[1], h = row.size()[1], top = sa.position()[1];
      return y >= top && y + h <= top + sa.size()[1];
    };
    if (!visible()) {
      const bar = sa.scrollBars().find((b) => { try { return b.orientation() === 'AXVerticalOrientation'; } catch (e) { return false; } });
      if (!bar) return done({ step: 'ROW_HIDDEN_NO_SCROLLBAR' });
      const span = list.size()[1] - sa.size()[1];
      const off = row.position()[1] - list.position()[1] - sa.size()[1] / 2 + row.size()[1] / 2;
      bar.value = Math.min(1, Math.max(0, off / span));
      if (!waitFor(visible, 12)) return done({ step: 'ROW_HIDDEN_AFTER_SCROLL' });
      out.scrolled = true;
    }

    phase = 'menu';
    const r = rowMenuOpen(row.uiElements[0]);
    if (r.step !== 'PRESSED') return done(r);
    if (mode === 'openlist') return done({ ok: true, step: 'PRESSED_LIST' });
    const opened = waitFor(() => count(title) >= 1, 24);
    return done({ ok: !!opened, step: opened ? 'OPENED' : 'NOT_OPENED_AFTER_PRESS' });
  } catch (e) {
    return done({ step: 'AX_ERROR', phase, err: String(e).slice(0, 200) });
  }
}

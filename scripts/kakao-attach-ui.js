// 카카오톡의 열린 채팅 창으로 사진·파일을 하나 보낸다. 마우스·키보드·클립보드를 쓰지 않고 카톡을 앞으로 띄우지 않는다(System Events 접근성만).
// 사용: osascript -l JavaScript kakao-attach-ui.js <창 제목> <check|send> <~/Downloads 바로 아래 파일 이름>
//  check : 확인 시트 「1개 전송」까지 가서 「취소」를 누른다(보내지 않는다)
//  send  : 확인 시트의 「1개 전송」을 누른다
// 순서: 「파일전송 ⌘O」 AXPress → 열기 시트(채팅 창에 붙는 시트라 사용자가 보던 창을 가리지 않는다) → 사이드바 「다운로드」 선택
//   → 그 이름의 파일을 골라 「열기」(계층 보기는 AX C API로 그 열의 AXSelectedChildren, 목록 보기는 줄 선택) → 확인 시트 「1개 전송」.
// 열기 시트는 마지막에 쓴 폴더·보기 방식으로 열린다(2026-11-18: 다운로드가 아닌 폴더·계층 보기로 열려, 목록 보기만 찾던 옛 판이 NO_LIST_VIEW로 멈췄다).
// 경로 입력(⇧⌘G)은 카톡 PID로 키를 보내도 먹지 않는다 — 그래서 파일은 ~/Downloads 바로 아래에 있어야 한다(kakao-send.py가 복사하고 지운다).
// 한 번에 하나만 보낸다. 사진 여러 장을 「사진 N장」 묶음 하나로 보내려면 kakao-clip-ui.js(클립보드 붙여넣기 — 카톡이 몇 초 앞으로 온다).
// 창·버튼 이름(파일전송, 다운로드, 열기, 취소, 1개 전송)은 한국어 UI에서 확인한 값이다.
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
// 출력: 한 줄 JSON {ok, step, view, front0, front1, ...}. 실제 전송 성공 판정은 이 출력이 아니라 DB의 새 행 type.
ObjC.import('Foundation');
ObjC.import('CoreGraphics');

// 열기 시트·확인 시트가 뜨면서 채팅 창이 사용자가 보던 창 위로 올라올 때가 있다(2026-11-18: Aside가 맨 앞일 때 올라왔고
// Ghostty가 맨 앞일 때는 아래에 머물렀다). 화면 맨 위 보통 창이 카톡 것이고 카톡이 맨 앞 앱이 아니면, 그 순간 맨 앞 앱의
// 초점 창을 다시 맨 위로 올린다(kakao-open-ui.js와 같은 함수). 시트는 뒤에 있어도 접근성으로 누를 수 있다.
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

function frontName(se) {
  try { return se.processes.whose({ frontmost: true })()[0].name(); } catch (e) { return null; }
}

function findRole(el, role, desc, depth) {
  if (depth < 0) return null;
  let kids = [];
  try { kids = el.uiElements(); } catch (e) { return null; }
  for (const k of kids) {
    try { if (k.role() === role && (!desc || k.description() === desc)) return k; } catch (e) {}
  }
  for (const k of kids) {
    let r = '';
    try { r = k.role(); } catch (e) {}
    if (r === 'AXOutline' || r === 'AXTable' || r === 'AXBrowser') continue;
    const f = findRole(k, role, desc, depth - 1);
    if (f) return f;
  }
  return null;
}

function rowName(row) {
  try {
    return row.uiElements[0].uiElements().map((e) => { try { return String(e.value() || e.name() || ''); } catch (x) { return ''; } }).join('|');
  } catch (e) { return ''; }
}

// 계층 보기 항목은 System Events로 고를 수 없다(AXSelected 속성이 없고, 목록의 AXSelectedChildren은 「유형을 변경할 수 없습니다」).
// 그래서 AX C API로 그 열 목록의 AXSelectedChildren을 그 항목으로 바꾼다(2026-11-23 실측: 오류 값은 -25205로 돌아와도 실제로 골라지고 「열기」가 켜진다).
ObjC.import('ApplicationServices');
function axGet(el, attr) { const r = Ref(); return $.AXUIElementCopyAttributeValue(el, $(attr), r) === 0 ? r[0] : null; }
function axArr(el, attr) {
  const v = axGet(el, attr);
  if (!v) return [];
  const a = ObjC.castRefToObject(v);
  const out = [];
  for (let i = 0; i < Number(a.count); i++) out.push(a.objectAtIndex(i));
  return out;
}
function axStr(el, attr) { const v = axGet(el, attr); if (!v) return null; try { return ObjC.unwrap(ObjC.castRefToObject(v)); } catch (e) { return null; } }
function axFindAll(el, role, depth, acc) {
  if (depth < 0) return acc;
  for (const k of axArr(el, 'AXChildren')) {
    if (axStr(k, 'AXRole') === role) acc.push(k);
    else axFindAll(k, role, depth - 1, acc);
  }
  return acc;
}
// 채팅 창(제목 title)의 열기 시트 계층 보기에서 이름이 맞는 항목을 골라 둔다. 고른 항목 수(그 열 목록의 AXSelectedChildren)를 돌려준다.
function axSelectInColumns(pid, title, same) {
  const app = $.AXUIElementCreateApplication(pid);
  const win = axArr(app, 'AXWindows').find((x) => axStr(x, 'AXTitle') === title);
  const sheet = win && axArr(win, 'AXChildren').find((x) => axStr(x, 'AXRole') === 'AXSheet');
  const browser = sheet && axFindAll(sheet, 'AXBrowser', 5, [])[0];
  if (!browser) return { err: 'AX_NO_BROWSER' };
  const hits = [];
  for (const list of axFindAll(browser, 'AXList', 4, [])) {
    for (const g of axArr(list, 'AXChildren')) {
      const tf = axArr(g, 'AXChildren').find((c) => axStr(c, 'AXRole') === 'AXTextField');
      if (tf && same(axStr(tf, 'AXValue') || '')) hits.push([list, g]);
    }
  }
  if (hits.length !== 1) return { err: hits.length ? 'AMBIGUOUS_FILE' : 'FILE_NOT_IN_LIST', count: hits.length };
  const [list, g] = hits[0];
  $.AXUIElementSetAttributeValue(list, $('AXSelectedChildren'), $.NSArray.arrayWithObject(g));
  return { selected: axArr(list, 'AXSelectedChildren').length };
}

function waitFor(fn, tries, step) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; delay(step || 0.25); }
  return null;
}

function run(argv) {
  const [title, mode, name] = argv;
  const se = Application('System Events');
  const out = { ok: false, step: '', front0: frontName(se) };
  let app = null;
  const done = (o) => {
    Object.assign(out, o);
    if (app) { delay(0.3); const raised = restoreFront(se, app); if (raised !== null) out.frontRaised = raised; }
    out.front1 = frontName(se);
    return JSON.stringify(out);
  };
  if (mode !== 'check' && mode !== 'send') return done({ step: 'BAD_MODE' });
  if (!name || argv.length !== 3) return done({ step: 'ONE_FILE_ONLY' });
  let p;
  try {
    const k = kakaoProcess(se);
    if (k.err) return done(Object.assign({ step: k.err }, k));
    p = k.p;
  } catch (e) { return done({ step: 'AX_ERROR', err: String(e).slice(0, 200) }); }
  const hasBox = (x) => { try { return x.scrollAreas().some((sa) => sa.textAreas().some((ta) => { try { return ta.description() === '메시지 입력'; } catch (e) { return false; } })); } catch (e) { return false; } };
  const w = (() => { try { return p.windows().find((x) => { try { return x.name() === title && hasBox(x); } catch (e) { return false; } }); } catch (e) { return null; } })();
  if (!w) return done({ step: 'WINDOW_NOT_OPEN', title });
  if (w.sheets.length) return done({ step: 'SHEET_ALREADY_OPEN' });
  const btn = w.buttons().find((b) => { try { return String(b.help() || '').indexOf('파일전송') === 0; } catch (e) { return false; } });
  if (!btn) return done({ step: 'NO_FILE_BUTTON' });

  let phase = 'panel';
  try {
    btn.actions.byName('AXPress').perform();
    const panel = waitFor(() => (w.sheets.length ? w.sheets[0] : null), 40, 0.1);
    if (!panel) return done({ step: 'NO_OPEN_PANEL' });
    app = p;
    restoreFront(se, p);
    const sg = panel.uiElements[0];
    const cancelPanel = () => { try { sg.buttons.byName('취소').actions.byName('AXPress').perform(); } catch (e) {} };

    phase = 'folder';
    const where = () => {
      try { return sg.popUpButtons().find((b) => String(b.name()).startsWith('위치')).value(); } catch (e) { return null; }
    };
    out.where0 = where();
    if (out.where0 !== '다운로드') {
      const side = findRole(sg, 'AXOutline', '사이드바', 3);
      const dl = side && side.rows().find((r) => rowName(r).split('|').indexOf('다운로드') >= 0);
      if (!dl) { cancelPanel(); return done({ step: 'NO_DOWNLOADS_IN_SIDEBAR' }); }
      dl.selected = true;
      if (!waitFor(() => where() === '다운로드', 12)) { cancelPanel(); return done({ step: 'CANNOT_GO_DOWNLOADS', where: where() }); }
    }

    phase = 'file';
    // 확장자를 숨기는 설정이면 이름이 확장자 없이 보인다 — 둘 다 맞춰 본다
    const nfc = (s) => String(s).normalize('NFC');
    const bare = name.replace(/\.[^.]+$/, '');
    const same = (v) => nfc(v) === nfc(name) || nfc(v) === nfc(bare);
    const browser = findRole(sg, 'AXBrowser', null, 3);
    const list = browser ? null : findRole(sg, 'AXOutline', '목록 보기', 4);
    if (browser) {
      // 계층 보기: 열마다 항목(이름 글칸을 가진 묶음)이 있다 — 이름으로 찾은 뒤 골라서 「열기」를 누른다
      out.view = 'column';
      const hits = waitFor(() => {
        const found = [];
        for (const col of browser.scrollAreas[0].scrollAreas()) {
          let names = [];
          try { names = col.lists[0].groups.textFields[0].value(); } catch (e) { continue; }
          names.forEach((v, i) => { if (same(v)) found.push(col.lists[0].groups[i]); });
        }
        return found.length ? found : null;
      }, 12);
      if (!hits) { cancelPanel(); return done({ step: 'FILE_NOT_IN_LIST' }); }
      if (hits.length > 1) { cancelPanel(); return done({ step: 'AMBIGUOUS_FILE', count: hits.length }); }
      // 항목의 AXOpen(더블클릭)은 먹지 않을 때가 있다(2026-11-23 1:1 방에 mp4: 같은 AXOpen이 18번 중 14번 안 됨, 확인 시트가 안 떠 NO_CONFIRM_SHEET).
      // 사람처럼 항목을 고른 뒤 「열기」 단추를 누른다 — 고르기는 AX C API(위 axSelectInColumns).
      const pick = axSelectInColumns(p.unixId(), title, same);
      out.selected = pick.selected;
      if (pick.err) { cancelPanel(); return done(Object.assign({ step: pick.err }, pick)); }
      const openBtn = sg.buttons.byName('열기');
      if (!waitFor(() => { try { return openBtn.enabled(); } catch (e) { return false; } }, 12)) { cancelPanel(); return done({ step: 'NOT_SELECTED' }); }
      openBtn.actions.byName('AXPress').perform();
    } else if (list) {
      out.view = 'list';
      const row = waitFor(() => list.rows().find((r) => rowName(r).split('|').some(same)), 12);
      if (!row) { cancelPanel(); return done({ step: 'FILE_NOT_IN_LIST' }); }
      // 줄 선택이 한 번에 안 먹을 때가 있다(2026-10-24 실측) — 3번까지 다시 고른다
      if (!waitFor(() => { row.selected = true; delay(0.3); return row.selected(); }, 3, 0.2)) { cancelPanel(); return done({ step: 'NOT_SELECTED' }); }
      sg.buttons.byName('열기').actions.byName('AXPress').perform();
    } else {
      // 아이콘 보기·갤러리 보기는 아직 다루지 않는다 — 보기 방식을 바꾸지 않고 멈춘다
      cancelPanel();
      return done({ step: 'NO_FILE_VIEW' });
    }

    phase = 'confirm';
    const want = '1개 전송';
    const confirm = waitFor(() => {
      if (!w.sheets.length) return null;
      try { const b = w.sheets[0].buttons.name(); return b.indexOf(want) >= 0 || (b.indexOf('취소') >= 0 && b.indexOf('열기') < 0 && !w.sheets[0].uiElements[0].popUpButtons.length) ? b : null; } catch (e) { return null; }
    }, 40, 0.15);
    if (!confirm) { cancelPanel(); return done({ step: 'NO_CONFIRM_SHEET' }); }
    restoreFront(se, p);
    out.sheetButtons = confirm;
    const sheet = w.sheets[0];
    if (mode === 'check' || confirm.indexOf(want) < 0) {
      sheet.buttons.byName('취소').actions.byName('AXPress').perform();
      delay(0.5);
      const closed = !w.sheets.length;
      return done({ ok: confirm.indexOf(want) >= 0 && closed, step: confirm.indexOf(want) >= 0 ? 'CHECK_OK' : 'COUNT_MISMATCH', sheetClosed: closed });
    }
    try { sheet.buttons.byName(want).actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
    delay(0.5);
    return done({ ok: true, step: 'PRESSED', sheetClosed: !w.sheets.length });
  } catch (e) {
    return done({ step: 'AX_ERROR', phase, err: String(e).slice(0, 200) });
  }
}

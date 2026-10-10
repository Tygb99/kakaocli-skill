// 카톡 채팅 창(이미 열린 창)으로 사진·파일을 보낸다. 사용자의 마우스·키보드·클립보드를 쓰지 않는다(System Events 접근성만).
// 순서: 「파일전송 ⌘O」 버튼 AXPress → 열기 시트에서 위치를 「다운로드」로 → 목록에서 파일 행 선택 → 「열기」 → 확인 시트 「N개 전송」.
// 열기 창에는 경로 입력칸이 없어서(⌘⇧G는 키 입력이 필요하다) 파일을 ~/Downloads에 미리 두어야 한다 — kakao-send.py가 복사하고 지운다.
// 창·버튼 이름(KakaoTalk, 파일전송 ⌘O, 다운로드, 열기, 취소, N개 전송)은 한국어 UI에서 확인한 값이다.
// 사용: osascript -l JavaScript kakao-attach-ui.js <창 제목> <check|send> <~/Downloads 안 파일 이름>
// 한 번에 하나만 보낸다 — 열기 창 목록은 접근성으로 여러 행을 고를 수 없다(AXSelectedRows 설정은 무시되고, 행 selected는 앞 선택을 푼다).
//  check : 확인 시트까지 가서 「취소」를 누른다(보내지 않는다)
//  send  : 확인 시트의 「N개 전송」을 누른다
// 출력: 한 줄 JSON {ok, step, front0, front1, ...}
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
    if (r === 'AXOutline' || r === 'AXTable') continue;
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

function waitFor(fn, tries) {
  for (let i = 0; i < tries; i++) { const v = fn(); if (v) return v; delay(0.25); }
  return null;
}

function run(argv) {
  const [title, mode, name] = argv;
  const se = Application('System Events');
  const out = { ok: false, step: '', front0: frontName(se) };
  const done = (o) => { Object.assign(out, o); out.front1 = frontName(se); return JSON.stringify(out); };
  if (mode !== 'check' && mode !== 'send') return done({ step: 'BAD_MODE' });
  if (!name || argv.length !== 3) return done({ step: 'ONE_FILE_ONLY' });
  const p = se.processes.byName('KakaoTalk');
  if (!p.exists()) return done({ step: 'NO_APP' });
  const w = p.windows.byName(title);
  if (!w.exists()) return done({ step: 'WINDOW_NOT_OPEN', title });
  if (w.sheets.length) return done({ step: 'SHEET_ALREADY_OPEN' });
  const btn = w.buttons().find((b) => { try { return b.help() === '파일전송 ⌘O'; } catch (e) { return false; } });
  if (!btn) return done({ step: 'NO_FILE_BUTTON' });

  btn.actions.byName('AXPress').perform();
  const panel = waitFor(() => (w.sheets.length ? w.sheets[0] : null), 20);
  if (!panel) return done({ step: 'NO_OPEN_PANEL' });
  const sg = panel.uiElements[0];
  const cancelPanel = () => { try { sg.buttons.byName('취소').actions.byName('AXPress').perform(); } catch (e) {} };

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

  const list = findRole(sg, 'AXOutline', '목록 보기', 4);
  if (!list) { cancelPanel(); return done({ step: 'NO_LIST_VIEW' }); }
  const bare = name.replace(/\.[^.]+$/, '');
  const row = waitFor(() => list.rows().find((r) => { const n = rowName(r).split('|'); return n.indexOf(name) >= 0 || n.indexOf(bare) >= 0; }), 12);
  if (!row) { cancelPanel(); return done({ step: 'FILE_NOT_IN_LIST' }); }
  row.selected = true;
  delay(0.3);
  if (!row.selected()) { cancelPanel(); return done({ step: 'NOT_SELECTED' }); }
  sg.buttons.byName('열기').actions.byName('AXPress').perform();

  const want = '1개 전송';
  const confirm = waitFor(() => {
    if (!w.sheets.length) return null;
    try { const b = w.sheets[0].buttons.name(); return b.indexOf('열기') < 0 ? b : null; } catch (e) { return null; }
  }, 24);
  if (!confirm) return done({ step: 'NO_CONFIRM_SHEET' });
  out.sheetButtons = confirm;
  const sheet = w.sheets[0];
  if (mode === 'check' || confirm.indexOf(want) < 0) {
    sheet.buttons.byName('취소').actions.byName('AXPress').perform();
    delay(0.5);
    const closed = !w.sheets.length;
    return done({ ok: confirm.indexOf(want) >= 0 && closed, step: confirm.indexOf(want) >= 0 ? 'CHECK_OK' : 'COUNT_MISMATCH', sheetClosed: closed });
  }
  try { sheet.buttons.byName(want).actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
  delay(1);
  return done({ ok: true, step: 'PRESSED', sheetClosed: !w.sheets.length });
}

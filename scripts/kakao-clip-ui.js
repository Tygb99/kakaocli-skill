// 카카오톡의 열린 채팅 창에 사진·파일을 클립보드로 붙여 보낸다. 1장·1개도 이 길로 간다(2026-10-24).
// 사용: osascript -l JavaScript kakao-clip-ui.js <창 제목> <check|send> <~/Downloads/파일1> [파일2 ...]
//  check : 붙여 넣어 확인 시트 「N개 전송」이 뜨는 것까지 보고 「취소」(보내지 않는다)
//  send  : 확인 시트의 「N개 전송」을 누른다(사진 여러 장이면 「사진 N장」 묶음, 「묶어보내기」 안내 시트가 뜨면 「확인」)
// 순서: 클립보드 통째로 저장 → 파일 URL·NSFilenamesPboardType로 채움 → 카톡을 잠깐 앞으로 → 창 AXRaise → 입력칸 초점
//       → 편집 > 붙여넣기 → 확인 시트 → 쓰던 앱을 다시 앞으로 → 클립보드 되돌림.
// 카톡이 뒤에 있으면 붙여넣기가 아무 일도 안 한다 — 그래서 몇 초 앞으로 띄운다. 파일은 ~/Downloads 아래여야 한다
// (외장 디스크 경로는 「존재하지 않는 항목」) — kakao-send.py가 같은 이름으로 복사하고 지운다.
// 창·메뉴·버튼 이름(편집, 붙여넣기/Paste, 메시지 입력, 취소, N개 전송, 확인)은 한국어 UI에서 확인한 값이다.
// 출력: 한 줄 JSON {ok, step, ...}. 실제 전송 성공 판정은 이 출력이 아니라 DB의 새 행 type.
// 대상 앱: 환경변수 KAKAO_BUNDLE_ID(기본 com.kakao.KakaoTalkMac), KAKAO_PID(있으면 그 PID 하나만, 번들 ID가 다르면 멈춤).
ObjC.import('AppKit');

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


function saveBoard(pb) {
  const saved = [];
  const items = pb.pasteboardItems;
  const n = items.js ? items.js.length : Number(items.count);
  for (let i = 0; i < n; i++) {
    const it = items.objectAtIndex(i);
    const types = it.types;
    const entry = [];
    for (let j = 0; j < Number(types.count); j++) {
      const t = types.objectAtIndex(j);
      const data = it.dataForType(t);
      if (!data.isNil()) entry.push([t, data]);
    }
    if (entry.length) saved.push(entry);
  }
  return saved;
}

function restoreBoard(pb, saved) {
  pb.clearContents;
  if (!saved.length) return true;
  const arr = $.NSMutableArray.array;
  for (const entry of saved) {
    const ni = $.NSPasteboardItem.alloc.init;
    for (const [t, data] of entry) ni.setDataForType(data, t);
    arr.addObject(ni);
  }
  return !!pb.writeObjects(arr);
}

function run(argv) {
  const [title, mode] = argv;
  const files = argv.slice(2);
  const n = files.length;
  const se = Application('System Events');
  const frontName = () => { try { const f = se.processes.whose({ frontmost: true })()[0]; return f.name() + ' ' + f.unixId(); } catch (e) { return null; } };
  const out = { ok: false, step: '', n, front0: frontName() };
  const done = (o) => { Object.assign(out, o); out.front1 = frontName(); return JSON.stringify(out); };
  if (mode !== 'check' && mode !== 'send') return done({ step: 'BAD_MODE' });
  if (!n) return done({ step: 'NO_FILES' });
  const fm = $.NSFileManager.defaultManager;
  const missing = files.filter((f) => !fm.fileExistsAtPath(f));
  if (missing.length) return done({ step: 'NO_SUCH_FILE', missing });

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

  const pb = $.NSPasteboard.generalPasteboard;
  const savedText = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
  const saved = saveBoard(pb);
  pb.clearContents;
  const urls = $.NSMutableArray.array; files.forEach((f) => urls.addObject($.NSURL.fileURLWithPath(f)));
  pb.writeObjects(urls);
  const names = $.NSMutableArray.array; files.forEach((f) => names.addObject($(f)));
  pb.setPropertyListForType(names, 'NSFilenamesPboardType');

  const prev = (() => { try { return se.processes.whose({ frontmost: true })()[0]; } catch (e) { return null; } })();
  const want = n + '개 전송';
  try {
    p.frontmost = true; delay(0.6);
    try { w.actions.byName('AXRaise').perform(); } catch (e) {}
    delay(0.4);
    try { out.kakaoFront = p.frontmost(); } catch (e) {}
    try { for (const sa of w.scrollAreas()) for (const ta of sa.textAreas()) { try { if (ta.description() === '메시지 입력') ta.focused = true; } catch (e) {} } } catch (e) {}
    delay(0.3);
    const edit = p.menuBars[0].menuBarItems().find((m) => { try { return m.name() === '편집'; } catch (e) { return false; } });
    const paste = edit && edit.menus[0].menuItems().find((i) => { try { return /^(Paste|붙여넣기)$/.test(i.name()); } catch (e) { return false; } });
    if (!paste) { out.step = 'NO_PASTE_MENU'; }
    else {
      paste.actions.byName('AXPress').perform();
      let btns = null;
      for (let i = 0; i < 30 && !btns; i++) { delay(0.25); if (w.sheets.length) { try { btns = w.sheets[0].buttons.name(); } catch (e) {} } }
      out.sheetButtons = btns;
      if (!btns) out.step = 'NO_CONFIRM_SHEET';
      else if (mode === 'check' || btns.indexOf(want) < 0) {
        try { w.sheets[0].buttons.byName('취소').actions.byName('AXPress').perform(); } catch (e) {}
        delay(0.5);
        out.sheetClosed = !w.sheets.length;
        out.ok = btns.indexOf(want) >= 0 && out.sheetClosed;
        out.step = btns.indexOf(want) >= 0 ? 'CHECK_OK' : 'COUNT_MISMATCH';
      } else {
        try { w.sheets[0].buttons.byName(want).actions.byName('AXPress').perform(); } catch (e) { /* 카톡은 AXPress에 오류를 내도 실제로 보낸다 — DB로 확인 */ }
        out.pressed = want;
        for (let i = 0; i < 12; i++) {
          delay(0.25);
          if (!w.sheets.length) continue;
          let b = []; try { b = w.sheets[0].buttons.name(); } catch (e) {}
          if (b.length === 1 && b[0] === '확인') {
            try { out.bundleSheet = w.sheets[0].staticTexts.value().slice(0, 2); } catch (e) {}
            w.sheets[0].buttons.byName('확인').actions.byName('AXPress').perform();
            out.bundleConfirmed = true;
            break;
          }
        }
        out.ok = true; out.step = 'PRESSED';
      }
    }
  } catch (e) { out.step = 'AX_ERROR'; out.err = String(e).slice(0, 200); }
  try { if (prev && prev.unixId() !== p.unixId()) prev.frontmost = true; } catch (e) {}
  out.clipRestored = restoreBoard(pb, saved);
  const after = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
  out.clipTextSame = (after === undefined || after === null ? null : after) === (savedText === undefined || savedText === null ? null : savedText);
  delay(0.5);
  try { out.sheetsAfter = w.sheets.length; } catch (e) {}
  return done({});
}

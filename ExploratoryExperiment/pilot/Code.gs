// Song Recognition Survey: Google Sheet backend.
// 1. Paste this whole file into Extensions → Apps Script (replace the starter code) and save.
// 2. Choose "setup" in the function menu and click Run once. It creates the tabs.
// 3. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).

// Column layout. New columns are only ever added at the end, so running setup()
// again on an existing Sheet just updates the header row.
const P_HEAD = ['received_at', 'pid', 'name', 'email', 'duplicate', 'age', 'gender', 'disney_films', 'musicals', 'device', 'correct', 'avg_response_s'];
const T_HEAD = ['received_at', 'pid', 'clip_id', 'position', 'response', 'text', 'response_ms', 'submit_ms', 'replays', 'paste_blocked', 'changed', 'correct'];
const NAME_MAX = 20;   // max display-name length (keep in sync with maxlength in index.html)
const P = { pid: 1, name: 2, email: 3, duplicate: 4, correct: 10, avg: 11 };            // 0-based
const T = { pid: 1, clip: 2, position: 3, response: 4, text: 5, response_ms: 6, submit_ms: 7, correct: 11 };

function setup() {
  const ss = SpreadsheetApp.getActive();
  function tab(name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
  function header(sh, cols) { sh.getRange(1, 1, 1, cols.length).setValues([cols]); sh.setFrozenRows(1); }

  const key = tab('Key');
  if (key.getLastRow() === 0) header(key, ['clip_id', 'title', 'alternate 1', 'alternate 2', 'alternate 3']);
  header(tab('Participants'), P_HEAD);
  header(tab('Trials'), T_HEAD);

  // Settings: one name/value pair per row
  const st = tab('Settings');
  if (st.getRange('A1').getValue() === '') st.getRange('A1:B1').setValues([['time_limit_s', 20]]);
  if (st.getRange('A2').getValue() === '') st.getRange('A2:B2').setValues([['leaderboard_top_n', 10]]);

  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
}

// Adds a "Survey" menu to the Sheet.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Survey').addItem('Rescore everyone', 'rescore').addToUi();
}

// The survey page posts:
//   { kind: "trial", pid, trial }  each time a participant clicks "Next excerpt",
//                                  so responses are kept even if they quit early;
//   { pid, name, email, ..., trials }  once at the end. Any trial that didn't
//                                  arrive earlier is added then (no duplicates),
//                                  and the participant's score is stored.
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = new Date();
    const ctx = context_();
    if (d.kind === 'trial') {
      appendTrials_(ctx, now, d.pid, [d.trial]);
      return json_({ ok: true });
    }
    const trials = d.trials || [];
    appendTrials_(ctx, now, d.pid, trials);

    const email = String(d.email || '').trim().toLowerCase();
    const duplicate = email !== '' && rows_('Participants').some(function (r) { return String(r[P.email]).toLowerCase() === email; });
    const s = summarize_(trials.filter(function (t) { return t && isCorrect_(ctx, t); })
                               .map(function (t) { return Number(t.response_ms); }));
    const name = String(d.name || '').trim().slice(0, NAME_MAX);   // the page also limits it
    sheet_('Participants').appendRow([now, d.pid, name, email, duplicate, d.age, d.gender,
      d.disney_films, d.musicals, d.device || '', s.correct, s.avg === null ? '' : s.avg]);

    const out = board_(ctx, d.pid);
    out.duplicate = duplicate;
    return json_(out);
  } finally {
    lock.releaseLock();
  }
}

// GET returns the leaderboard only: names, scores, times. Never emails.
function doGet() { return json_(board_(context_(), null)); }

// Everything scoring needs, read once per request.
function context_() {
  const st = sheet_('Settings').getRange('A1:B2').getValues();
  const key = {};
  rows_('Key').forEach(function (r) {
    if (r[0] !== '') key[String(r[0]).trim()] = keyVariants_(r.slice(1));
  });
  return { limitMs: Number(st[0][1]) * 1000, topN: Number(st[1][1]) || 10, key: key, seen: {} };
}

// A trial scores if the participant chose "title", submitted within the time
// limit, and the title matches. Results are cached per (clip, answer).
function isCorrect_(ctx, t) {
  if (t.response !== 'title' || !(Number(t.submit_ms) <= ctx.limitMs)) return false;
  const clip = String(t.clip_id).trim(), text = String(t.text || '');
  const k = clip + '\u0000' + text;
  if (!(k in ctx.seen)) ctx.seen[k] = matches_(text, ctx.key[clip] || []);
  return ctx.seen[k];
}

function summarize_(correctTimesMs) {
  const n = correctTimesMs.length;
  const avg = n ? Math.round(correctTimesMs.reduce(function (a, b) { return a + b; }, 0) / n / 100) / 10 : null;
  return { correct: n, avg: avg };
}

// Adds trials for this participant, skipping positions already saved, and
// stores whether each one scored.
function appendTrials_(ctx, now, pid, trials) {
  const have = {};
  rows_('Trials').forEach(function (r) { if (r[T.pid] === pid) have[r[T.position]] = true; });
  const rows = trials.filter(function (t) { return t && !have[t.position]; }).map(function (t) {
    have[t.position] = true;
    return [now, pid, t.clip_id, t.position, t.response, t.text || '', t.response_ms, t.submit_ms,
      t.replays, t.paste_blocked, t.changed, isCorrect_(ctx, t)];
  });
  if (rows.length) {
    const sh = sheet_('Trials');
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
}

// Leaderboard from the stored scores in Participants only (no rescoring).
// Returns the top N, plus the requesting participant's own row and rank.
function board_(ctx, pid) {
  const all = rows_('Participants').map(function (r, i) {
    return {
      pid: r[P.pid], name: r[P.name], order: i,
      listed: r[P.name] !== '' && r[P.duplicate] !== true,
      correct: Number(r[P.correct]) || 0,
      avg_s: r[P.avg] === '' ? null : Number(r[P.avg])
    };
  });
  const ranked = all.filter(function (p) { return p.listed; }).sort(function (a, b) {
    return (b.correct - a.correct)
      || ((a.avg_s === null) - (b.avg_s === null))
      || ((a.avg_s || 0) - (b.avg_s || 0))
      || (a.order - b.order);                       // earlier finisher wins a full tie
  });
  ranked.forEach(function (p, i) { p.rank = i + 1; });

  function row(p) { return { rank: p.rank || null, name: p.name, correct: p.correct, avg_s: p.avg_s, me: p.pid === pid }; }
  let mine = null;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].pid === pid) { mine = all[i]; break; }
  return {
    board: ranked.slice(0, ctx.topN).map(row),
    me: mine ? row(mine) : null,
    total: ranked.length
  };
}

// Recalculates every stored score: Trials "correct" and Participants
// "correct" / "avg_response_s". Run it from the Survey menu after changing
// the Key tab or the time limit. Done in bulk, so it stays fast.
function rescore() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ctx = context_();
    const tSheet = sheet_('Trials'), tRows = rows_('Trials');
    const byPid = {};
    const flags = tRows.map(function (r) {
      const ok = isCorrect_(ctx, { response: r[T.response], submit_ms: r[T.submit_ms], clip_id: r[T.clip], text: r[T.text] });
      if (ok) (byPid[r[T.pid]] = byPid[r[T.pid]] || []).push(Number(r[T.response_ms]));
      return [ok];
    });
    if (flags.length) tSheet.getRange(2, T.correct + 1, flags.length, 1).setValues(flags);

    const pSheet = sheet_('Participants'), pRows = rows_('Participants');
    const scores = pRows.map(function (r) {
      const s = summarize_(byPid[r[P.pid]] || []);
      return [s.correct, s.avg === null ? '' : s.avg];
    });
    if (scores.length) pSheet.getRange(2, P.correct + 1, scores.length, 2).setValues(scores);
    SpreadsheetApp.getActive().toast('Rescored ' + pRows.length + ' participants.');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Title matching. An answer counts if, after cleanup, it is within the typo
// allowance of the title or one of its alternates in the Key tab.
//
// Cleanup (both answer and key):
//   - capitals, accents, punctuation, apostrophes and "the / a / an" are ignored
//   - "&" = "and", "wanna" = "want to", "gonna" = "going to"
//   - spaces are ignored ("River Bend" = "Riverbend", "Lalalu" = "La La Lu")
// Key only:  the bracketed part is optional, so "Part of Your World" counts
//            for "Part of Your World (Reprise)".
// Answer only: anything added after ( - : "from" or "by" is ignored, so
//            "Reflection - Mulan" and "Go the Distance from Hercules" count.
// Typos (counted on the title without spaces; swapped letters = 1 error):
//   3 letters or fewer: exact   4-7 letters: 1 error   8+: 1 per 5 letters
// Partial titles and lyrics only count if listed as alternates.
// ---------------------------------------------------------------------------
function norm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/['’`]/g, '')
    .replace(/\bwanna\b/g, 'want to').replace(/\bgonna\b/g, 'going to')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ')
    .replace(/\s+/g, '');
}
function keyVariants_(cells) {
  const out = [];
  cells.forEach(function (c) {
    const raw = String(c).trim();
    if (!raw) return;
    [raw, raw.replace(/\([^)]*\)/g, ' ')].forEach(function (v) {
      const n = norm_(v);
      if (n && out.indexOf(n) < 0) out.push(n);
    });
  });
  return out;
}
function answerVariants_(text) {
  const raw = String(text || '');
  const out = [norm_(raw)];
  const cut = raw.toLowerCase().search(/\(|\s[-–—]\s|:|\sfrom\s|\sby\s/);
  if (cut > 0) out.push(norm_(raw.slice(0, cut)));
  return out.filter(function (x) { return x; });
}
function allowance_(len) { return len <= 3 ? 0 : len <= 7 ? 1 : Math.floor(len / 5); }
function matches_(text, keyVars) {
  return answerVariants_(text).some(function (a) {
    return keyVars.some(function (k) {
      if (a === k) return true;
      const allow = allowance_(k.length);
      return allow > 0 && Math.abs(a.length - k.length) <= allow && dist_(a, k) <= allow;
    });
  });
}
// Edit distance where swapping two neighbouring letters counts as one error.
function dist_(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) d[i] = [i];
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }
function rows_(name) { return sheet_(name).getDataRange().getValues().slice(1); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

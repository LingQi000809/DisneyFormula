// Song Recognition Survey: Google Sheet backend.
// 1. Paste this whole file into Extensions → Apps Script (replace the starter code) and save.
// 2. Choose "setup" in the function menu and click Run once. It creates the tabs.
// 3. Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
//    After editing this file later: Deploy → Manage deployments → Edit → New version.

// Column layout. Rescore writes by column position, so after changing this,
// run setup() again and clear old rows that used a different layout.
const P_HEAD = ['received_at', 'pid', 'status', 'email', 'duplicate', 'lottery', 'age', 'gender', 'disney_films', 'musicals', 'us_located', 'timezone', 'device', 'correct'];
const T_HEAD = ['received_at', 'pid', 'clip_id', 'position', 'response', 'text', 'response_ms', 'submit_ms', 'replays', 'paste_blocked', 'changed', 'correct'];
const WINNERS = 3;
const P = { pid: 1, status: 2, email: 3, lottery: 5, correct: 13 };            // 0-based
const T = { pid: 1, clip: 2, position: 3, response: 4, text: 5, response_ms: 6, submit_ms: 7, correct: 11 };

function setup() {
  const ss = SpreadsheetApp.getActive();
  function tab(name) { return ss.getSheetByName(name) || ss.insertSheet(name); }
  function header(sh, cols) { sh.getRange(1, 1, 1, cols.length).setValues([cols]); sh.setFrozenRows(1); }

  const key = tab('Key');
  if (key.getLastRow() === 0) header(key, ['clip_id', 'title', 'alternate 1', 'alternate 2', 'alternate 3']);
  header(tab('Participants'), P_HEAD);
  header(tab('Trials'), T_HEAD);

  const first = ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
}

// Adds a "Survey" menu to the Sheet.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Survey')
    .addItem('Rescore everyone', 'rescore')
    .addItem('Draw ' + WINNERS + ' lottery winners', 'drawWinners')
    .addToUi();
}

// The survey page posts:
//   { kind: "screened", pid, email, age, ... }  when someone doesn't pass the
//                                  screening questions (no excerpts, no lottery entry);
//   { kind: "trial", pid, trial }  each time a participant clicks "Next excerpt",
//                                  so responses are kept even if they quit early;
//   { pid, lottery, email, ..., trials }  once at the end. Any trial that didn't
//                                  arrive earlier is added then (no duplicates).
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const now = new Date();
    // Email is asked before screening, so a screened-out email is on record and
    // a retry with the same email is caught as a duplicate.
    const email = d.lottery ? String(d.email || '').trim().toLowerCase() : '';
    const duplicate = email !== '' && rows_('Participants').some(function (r) { return emailKey_(r[P.email]) === emailKey_(email); });
    if (d.kind === 'screened') {
      appendParticipant_(now, d, 'screened_out', email, duplicate, false, '');
      return json_({ ok: true });
    }
    const ctx = context_();
    if (d.kind === 'trial') {
      appendTrials_(ctx, now, d.pid, [d.trial]);
      return json_({ ok: true });
    }
    const trials = d.trials || [];
    appendTrials_(ctx, now, d.pid, trials);

    // One lottery entry per email, and none for an email that was screened out
    // before. "Name+tag@" and Gmail dots count as the same address.
    const correct = trials.filter(function (t) { return t && isCorrect_(ctx, t); }).length;
    appendParticipant_(now, d, 'complete', email, duplicate, email !== '' && !duplicate, correct);
    return json_({ ok: true, correct: correct, duplicate: duplicate });
  } finally {
    lock.releaseLock();
  }
}

// GET is only a health check; nothing about participants is exposed.
function doGet() { return json_({ ok: true }); }

function appendParticipant_(now, d, status, email, duplicate, lottery, correct) {
  sheet_('Participants').appendRow([now, d.pid, status, email, duplicate, lottery, d.age, d.gender,
    d.disney_films, d.musicals, d.us_located, d.timezone || '', d.device || '', correct]);
}

function emailKey_(e) {
  const m = String(e || '').trim().toLowerCase().match(/^([^@+]+)(?:\+[^@]*)?@(.+)$/);
  if (!m) return String(e || '').trim().toLowerCase();
  const gmail = m[2] === 'gmail.com' || m[2] === 'googlemail.com';
  return (gmail ? m[1].replace(/\./g, '') : m[1]) + '@' + (gmail ? 'gmail.com' : m[2]);
}

// The title key, read once per request.
function context_() {
  const key = {};
  rows_('Key').forEach(function (r) {
    if (r[0] !== '') key[String(r[0]).trim()] = keyVariants_(r.slice(1));
  });
  return { key: key, seen: {} };
}

// A trial is correct if the participant chose "title" and the title matches.
// Response times are stored separately, so any time cutoff can be applied in
// the analysis. Results are cached per (clip, answer).
function isCorrect_(ctx, t) {
  if (t.response !== 'title') return false;
  const clip = String(t.clip_id).trim(), text = String(t.text || '');
  const k = clip + '\u0000' + text;
  if (!(k in ctx.seen)) ctx.seen[k] = matches_(text, ctx.key[clip] || []);
  return ctx.seen[k];
}

// Adds trials for this participant, skipping positions already saved, and
// stores whether each one is correct.
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

// Recalculates Trials "correct" and Participants "correct". Run it from the
// Survey menu after changing the Key tab.
function rescore() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ctx = context_();
    const tSheet = sheet_('Trials'), tRows = rows_('Trials');
    const byPid = {};
    const flags = tRows.map(function (r) {
      const ok = isCorrect_(ctx, { response: r[T.response], clip_id: r[T.clip], text: r[T.text] });
      if (ok) byPid[r[T.pid]] = (byPid[r[T.pid]] || 0) + 1;
      return [ok];
    });
    if (flags.length) tSheet.getRange(2, T.correct + 1, flags.length, 1).setValues(flags);

    const pSheet = sheet_('Participants'), pRows = rows_('Participants');
    const scores = pRows.map(function (r) { return [r[P.status] === 'complete' ? (byPid[r[P.pid]] || 0) : '']; });
    if (scores.length) pSheet.getRange(2, P.correct + 1, scores.length, 1).setValues(scores);
    SpreadsheetApp.getActive().toast('Rescored ' + pRows.length + ' participants.');
  } finally {
    lock.releaseLock();
  }
}

// Picks WINNERS rows at random among Participants with lottery = TRUE and
// writes them to a "Winners" tab. To exclude someone (e.g. careless answers),
// set their lottery cell to FALSE before drawing.
function drawWinners() {
  const pool = rows_('Participants').filter(function (r) { return r[P.lottery] === true; });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const x = pool[i]; pool[i] = pool[j]; pool[j] = x;
  }
  const picked = pool.slice(0, WINNERS);
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName('Winners') || ss.insertSheet('Winners');
  sh.clear();
  sh.appendRow(['drawn_at', 'pid', 'email', 'entries_in_pool']);
  const now = new Date();
  picked.forEach(function (r) { sh.appendRow([now, r[P.pid], r[P.email], pool.length]); });
  ss.toast('Drew ' + picked.length + ' of ' + pool.length + ' entries. See the Winners tab.');
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

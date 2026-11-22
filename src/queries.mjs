// Named queries. Rules here are fixed by docs/decisions/2026-11-22-strata-design.md before any baseline is read.
import { KNOWN_TYPES, IGNORED_TYPES, isDefaultBranch } from './adapter-claude.mjs';

export const IDLE_MIN = 5;          // design: primary idle threshold; 2 and 15 always reported
export const PROMPT_FLOOR_MIN = 1;  // prompt-weighted proxy: floor per owner prompt ...
export const PROMPT_SEC_PER_20 = 1; // ... plus 1 s per 20 characters ...
export const PROMPT_CAP_MIN = 5;    // ... capped

// ---- missions: sessions joined by structured links (design amendment 1) ----
export function missions(db, { repo } = {}) {
  const sess = new Map(); // id -> {repo, branch}
  for (const r of db.prepare(`SELECT session_id s, max(cwd) cwd, max(CASE WHEN branch IS NOT NULL THEN branch END) br
      FROM events WHERE session_id IS NOT NULL GROUP BY session_id`).all()) sess.set(r.s, { cwd: r.cwd, branch: r.br });
  const parent = new Map([...sess.keys()].map((k) => [k, k]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const causes = new Map();
  const join = (a, b, why) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const ra = find(a), rb = find(b); if (ra === rb) return;
    parent.set(ra, rb);
    const c = causes.get(rb) || {}; c[why] = (c[why] || 0) + 1; causes.set(rb, c);
  };
  for (const r of db.prepare("SELECT session_id s, type, link_to FROM events WHERE link_to IS NOT NULL").all())
    for (const t of String(r.link_to).split(',')) join(r.s, t, r.type);
  const byPr = new Map();
  for (const r of db.prepare('SELECT DISTINCT session_id s, pr_repo, pr_num FROM events WHERE pr_num IS NOT NULL').all()) {
    const k = `${r.pr_repo}#${r.pr_num}`; if (byPr.has(k)) join(r.s, byPr.get(k), 'shared-pr'); else byPr.set(k, r.s);
  }
  const byBranch = new Map();
  for (const [id, m] of sess) {
    if (!m.branch || isDefaultBranch(m.branch)) continue;
    const k = `${m.cwd ? m.cwd.split('/wt-')[0] : ''}|${m.branch}`;
    if (byBranch.has(k)) join(id, byBranch.get(k), 'shared-branch'); else byBranch.set(k, id);
  }
  const groups = new Map();
  for (const id of sess.keys()) { const r = find(id); (groups.get(r) || groups.set(r, []).get(r)).push(id); }
  let out = [...groups.entries()].map(([root, ids]) => ({ id: root, sessions: ids, joins: causes.get(root) || {} }));
  if (repo) { const rows = db.prepare('SELECT DISTINCT session_id s FROM events WHERE pr_repo LIKE ? OR cwd LIKE ?').all(`%${repo}%`, `%${repo}%`); const ok = new Set(rows.map((r) => r.s)); out = out.filter((m) => m.sessions.some((s) => ok.has(s))); }
  return out;
}

// ---- interval helpers ----
function merge(iv) {
  iv.sort((a, b) => a[0] - b[0]); const out = [];
  for (const x of iv) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
}
const total = (iv) => merge(iv).reduce((a, [s, e]) => a + (e - s), 0) / 60000;

// Per-session PR attribution: interval -> PR in force (most recent earlier pr-link, else first link).
function sessionIntervals(db, sid, idleMs) {
  const ev = db.prepare('SELECT ts,type,pr_repo,pr_num,owner_prompt,prompt_len,interrupted,rejected,perm FROM events WHERE session_id=? AND ts IS NOT NULL ORDER BY ts').all(sid);
  const links = ev.filter((e) => e.pr_num != null).map((e) => ({ ts: e.ts, key: `${e.pr_repo}#${e.pr_num}` }));
  const distinct = new Set(links.map((l) => l.key));
  const out = [];
  for (let i = 1; i < ev.length; i++) {
    const a = ev[i - 1].ts, b = ev[i].ts; if (b - a > idleMs || b <= a) continue;
    let key = 'no-pr', flag = false;
    if (links.length) {
      const earlier = links.filter((l) => l.ts <= a); key = (earlier.length ? earlier[earlier.length - 1] : links[0]).key;
      flag = distinct.size > 1; // work before the first link is normal (the PR is opened last), not ambiguous
    }
    out.push({ s: a, e: b, key, flag });
  }
  return { ev, out, links, distinct };
}

function weekOf(ms) { const d = new Date(ms); const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * 86400000).toISOString().slice(0, 10); }

// human-minutes-per-merged-pr: per PR, idle-gap union plus the side-by-side proxies.
export function humanMinutes(db, { idle = IDLE_MIN, repo, by } = {}) {
  const idleMs = idle * 60000;
  const perPr = new Map();
  const get = (k) => perPr.get(k) || perPr.set(k, { pr: k, iv: [], eq: 0, flagged: [], prompts: 0, approvals: 0, rejections: 0, interruptions: 0, promptMin: 0, first: null, last: null, sessions: new Set() }).get(k);
  for (const m of missions(db, { repo })) {
    for (const sid of m.sessions) {
      const { ev, out, distinct } = sessionIntervals(db, sid, idleMs);
      for (const x of out) {
        const p = get(x.key); p.iv.push([x.s, x.e]); if (x.flag) p.flagged.push([x.s, x.e]);
        // sensitivity: equal split across every PR the session links
        const targets = distinct.size > 1 ? [...distinct] : [x.key];
        for (const k of targets) get(k).eq += (x.e - x.s) / 60000 / targets.length;
      }
      // proxies and wall clock are attributed to the PR in force at the event
      const links = ev.filter((e) => e.pr_num != null).map((e) => ({ ts: e.ts, key: `${e.pr_repo}#${e.pr_num}` }));
      for (const e of ev) {
        let key = 'no-pr';
        if (links.length) { const earlier = links.filter((l) => l.ts <= e.ts); key = (earlier.length ? earlier[earlier.length - 1] : links[0]).key; }
        const p = get(key); p.sessions.add(sid);
        p.first = p.first == null ? e.ts : Math.min(p.first, e.ts); p.last = p.last == null ? e.ts : Math.max(p.last, e.ts);
        if (e.owner_prompt) { p.prompts++; p.promptMin += Math.min(PROMPT_CAP_MIN, PROMPT_FLOOR_MIN + (e.prompt_len / 20) * PROMPT_SEC_PER_20 / 60); }
        if (e.perm === 'accept') p.approvals++;
        if (e.rejected || (e.perm && e.perm !== 'accept')) p.rejections++;
        if (e.interrupted) { p.interruptions++; }
      }
    }
  }
  const snap = new Map(db.prepare('SELECT * FROM prs').all().map((r) => [`${r.repo}#${r.num}`, r]));
  const rows = [...perPr.values()].map((p) => {
    const s = snap.get(p.pr);
    return { pr: p.pr, merged: s ? (s.merged_at ? true : false) : null, sessions: p.sessions.size,
      active_min: round(total(p.iv)), equal_split_min: round(p.eq), flagged_min: round(total(p.flagged)),
      prompts: p.prompts, approvals: p.approvals, rejections: p.rejections, interruptions: p.interruptions,
      prompt_weighted_min: round(p.promptMin), wall_clock_min: p.first == null ? 0 : round((p.last - p.first) / 60000),
      week: p.last ? weekOf(p.last) : null };
  });
  const prRows = rows.filter((r) => r.pr !== 'no-pr');
  const haveSnap = snap.size > 0;
  const denom = haveSnap ? prRows.filter((r) => r.merged) : prRows;
  const sum = (a, f) => a.reduce((x, r) => x + r[f], 0);
  const summary = {
    idle_min: idle, denominator: haveSnap ? 'merged PRs (gh snapshot)' : 'PRs linked (no gh snapshot; merge state unknown)',
    prs: denom.length, active_min_total: round(sum(denom, 'active_min')),
    active_min_per_pr: denom.length ? round(sum(denom, 'active_min') / denom.length) : null,
    trimmed_mean_active_min: round(trimmedMean(denom.map((r) => r.active_min), 0.1)),
    flagged_share: sum(denom, 'active_min') ? round(sum(denom, 'flagged_min') / sum(denom, 'active_min')) : null,
    proxies: { prompts_per_pr: denom.length ? round(sum(denom, 'prompts') / denom.length) : null,
      prompt_weighted_min_per_pr: denom.length ? round(sum(denom, 'prompt_weighted_min') / denom.length) : null,
      wall_clock_min_per_pr: denom.length ? round(sum(denom, 'wall_clock_min') / denom.length) : null },
    equal_split_sensitivity: { active_min_per_pr: denom.length ? round(sum(denom, 'equal_split_min') / denom.length) : null,
      trimmed_mean_active_min: round(trimmedMean(denom.map((r) => r.equal_split_min), 0.1)),
      note: 'a session that links several PRs is split equally across them; no union across sessions, so a slight overcount' },
    no_pr_active_min: round(sum(rows.filter((r) => r.pr === 'no-pr'), 'active_min'))
  };
  if (by === 'week') {
    const w = {}; for (const r of denom) (w[r.week] ||= []).push(r.active_min);
    summary.by_week = Object.fromEntries(Object.entries(w).sort().map(([k, v]) => [k, { prs: v.length, trimmed_mean_active_min: round(trimmedMean(v, 0.1)) }]));
  }
  return { summary, rows };
}

export function interventions(db, { repo, seed = 1 } = {}) {
  const per = new Map();
  for (const m of missions(db, { repo })) for (const sid of m.sessions) {
    const rows = db.prepare('SELECT tool_use_ids,rejected,perm,hook_err,interrupted FROM events WHERE session_id=?').all(sid);
    const ids = new Set(); let sig = 0;
    for (const r of rows) {
      if (r.tool_use_ids) for (const i of r.tool_use_ids.split(',')) ids.add(i);
      if (r.rejected) sig++; if (r.perm && r.perm !== 'accept') sig++; if (r.hook_err) sig++; if (r.interrupted) sig++;
    }
    per.set(sid, { calls: ids.size, sig });
  }
  const arr = [...per.values()]; const calls = arr.reduce((a, x) => a + x.calls, 0), sig = arr.reduce((a, x) => a + x.sig, 0);
  const rate = (a) => { const c = a.reduce((x, y) => x + y.calls, 0); return c ? (100 * a.reduce((x, y) => x + y.sig, 0)) / c : 0; };
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const boots = []; for (let b = 0; b < 1000 && arr.length; b++) boots.push(rate(Array.from({ length: arr.length }, () => arr[Math.floor(rnd() * arr.length)])));
  boots.sort((a, b) => a - b);
  return { tool_calls: calls, signals: sig, per_100_calls: calls ? round((100 * sig) / calls) : null,
    interval80: boots.length ? [round(boots[Math.floor(boots.length * 0.1)]), round(boots[Math.floor(boots.length * 0.9)])] : null,
    sessions: arr.length, note: calls < 100 ? 'too few calls (<100)' : undefined, signals_def: 'rejected call, non-accept permission decision, hook error, interruption' };
}

export function coverage(db) {
  const rows = db.prepare('SELECT type, count(*) n FROM events GROUP BY type ORDER BY n DESC').all();
  const bad = db.prepare("SELECT count(*) n FROM events WHERE kind='unparsable'").get().n;
  let classified = 0, ignored = 0, unknown = 0; const unknownTypes = [];
  for (const r of rows) {
    if (r.type == null) continue;
    if (IGNORED_TYPES.has(r.type)) ignored += r.n; else if (KNOWN_TYPES.has(r.type)) classified += r.n; else { unknown += r.n; unknownTypes.push(r); }
  }
  return { events: rows.reduce((a, r) => a + r.n, 0), classified, ignored, unknown, unparsable_stored_raw: bad, unknown_types: unknownTypes,
    by_type: rows.map((r) => ({ type: r.type, n: r.n, class: r.type == null ? 'unparsable' : IGNORED_TYPES.has(r.type) ? 'ignored' : KNOWN_TYPES.has(r.type) ? 'classified' : 'UNKNOWN' })) };
}

// Counts and flags only. Nothing from `raw`, no prompt text, no paths.
export function exportCounts(db, opts = {}) {
  const hm = humanMinutes(db, opts);
  return { schema: 1, coverage: { ...coverage(db), unknown_types: coverage(db).unknown_types.map((t) => ({ type: t.type, n: t.n })) },
    human_minutes: hm.summary, interventions: interventions(db, opts),
    missions: missions(db, opts).length, per_pr: hm.rows.map(({ pr, ...r }, i) => ({ id: i, ...r })) };
}

const round = (x) => Math.round(x * 100) / 100;
function trimmedMean(a, frac) {
  if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length * frac);
  const t = s.slice(k, s.length - k); return (t.length ? t : s).reduce((x, y) => x + y, 0) / (t.length || s.length);
}

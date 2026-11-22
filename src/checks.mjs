// Checks that nothing is lost, a sample for the owner's hand check, and the format-drift canary.
import { KNOWN_TYPES, IGNORED_TYPES } from './adapter-claude.mjs';
import { missions } from './queries.mjs';

// Does every line of every file have a home in the index?
export function verify(db) {
  const files = db.prepare('SELECT path, lines, byte_offset, size, status FROM files').all();
  const cnt = new Map(db.prepare('SELECT file, count(*) n FROM events GROUP BY file').all().map((r) => [r.file, r.n]));
  let lines = 0, events = 0, partial = 0; const worst = [];
  for (const f of files) {
    const n = cnt.get(f.path) || 0; lines += f.lines; events += n;
    if (f.byte_offset < f.size) partial++;
    if (f.lines > n) worst.push({ file: f.path.split('/').slice(-2).join('/'), lines: f.lines, events: n });
  }
  worst.sort((a, b) => (b.lines - b.events) - (a.lines - a.events));
  return {
    files: files.length, lines, events, lines_without_own_event: lines - events,
    note: 'a line without its own event is blank or an exact duplicate of a line stored for the same session; the raw bytes stay in the archive',
    files_with_unread_tail: partial, rotated: files.filter((f) => f.status === 'rotated').length, top_collapsed: worst.slice(0, 5)
  };
}

// Rows for the hand check (S2): ids and counts only, never text. Multi-PR missions are oversampled.
export function sample(db, { n = 20, seed = 7, repo } = {}) {
  let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const ms = missions(db, { repo }).map((m) => {
    const r = db.prepare(`SELECT count(*) n, min(ts) a, max(ts) b, sum(owner_prompt) p,
        count(DISTINCT CASE WHEN pr_num IS NOT NULL THEN pr_repo||'#'||pr_num END) prs
      FROM events WHERE session_id IN (${m.sessions.map(() => '?').join(',')})`).get(...m.sessions);
    return { mission: m.id, sessions: m.sessions.length, joins: m.joins, events: r.n, prompts: r.p, prs: r.prs,
      from: r.a ? new Date(r.a).toISOString() : null, minutes_wall: r.a ? Math.round((r.b - r.a) / 60000) : 0 };
  }).filter((m) => m.events > 20);
  const pick = (a, k) => { const c = [...a]; const o = []; while (o.length < k && c.length) o.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return o; };
  const multi = ms.filter((m) => m.prs > 1), single = ms.filter((m) => m.prs <= 1);
  const half = Math.ceil(n / 2);
  const a = pick(multi, half);
  return { episodes: [...a, ...pick(single, n - a.length)] };
}

// Format drift: unclassified event types in logs from the last `days`.
export function canary(db, { days = 14 } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare('SELECT type, count(*) n FROM events WHERE ts >= ? GROUP BY type').all(since);
  const unknown = rows.filter((r) => r.type != null && !KNOWN_TYPES.has(r.type) && !IGNORED_TYPES.has(r.type));
  const bad = db.prepare("SELECT count(*) n FROM events WHERE kind='unparsable'").get().n;
  return { days, event_types_seen: rows.length, unknown, unparsable: bad, ok: unknown.length === 0 };
}

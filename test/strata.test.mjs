import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db.mjs';
import { ingest } from '../src/ingest.mjs';
import { humanMinutes, interventions, coverage, exportCounts, missions } from '../src/queries.mjs';

const T0 = Date.parse('2026-11-02T10:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const MARK = 'SECRET-MARKER-xyzzy';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const sessionA = [
  { type: 'user', uuid: 'u1', sessionId: A, timestamp: at(0), isSidechain: false, gitBranch: 'feat/x', cwd: '/r', message: { role: 'user', content: `please do ${MARK}` } },
  { type: 'assistant', uuid: 'a1', sessionId: A, timestamp: at(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } },
  { type: 'user', uuid: 'u2', sessionId: A, timestamp: at(1), permissionDecision: { decision: 'deny', source: 'user' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: "The user doesn't want to proceed" }] } },
  { type: 'user', uuid: 'u3', sessionId: A, timestamp: at(3), message: { role: 'user', content: 'ok go on' } },
  { type: 'assistant', uuid: 'a2', sessionId: A, timestamp: at(4), message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit' }] } },
  { type: 'pr-link', sessionId: A, prNumber: 7, prRepository: 'o/x', timestamp: at(20) },
  { type: 'user', uuid: 'u4', sessionId: A, timestamp: at(40), message: { role: 'user', content: 'later' } },
  { type: 'brand-new-event', sessionId: A, timestamp: at(41), uuid: 'z1' },
  { type: 'continued-in', sessionId: A, continuedInSessionId: B, timestamp: at(41) }
];
const sessionB = [
  { type: 'user', uuid: 'v1', sessionId: B, timestamp: at(42), message: { role: 'user', content: 'continue' } },
  { type: 'pr-link', sessionId: B, prNumber: 7, prRepository: 'o/x', timestamp: at(43) }
];
const lines = (a) => a.map((x) => JSON.stringify(x)).join('\n') + '\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'strata-'));
  writeFileSync(join(root, `${A}.jsonl`), lines(sessionA) + 'not json at all\n');
  writeFileSync(join(root, `${B}.jsonl`), lines(sessionB));
  return { root, db: open(':memory:') };
}

test('ingest twice is a no-op; unparsable lines kept raw', () => {
  const { root, db } = setup();
  const r1 = ingest(db, root);
  const n1 = db.prepare('SELECT count(*) n FROM events').get().n;
  const r2 = ingest(db, root);
  assert.equal(r2.added, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, n1);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='unparsable'").get().n, 1);
  assert.ok(r1.added > 0);
});

test('append-only growth reads only new lines; a partial last line waits', () => {
  const { root, db } = setup();
  ingest(db, root);
  const f = join(root, `${B}.jsonl`);
  appendFileSync(f, JSON.stringify({ type: 'user', uuid: 'v2', sessionId: B, timestamp: at(44), message: { content: 'more' } }).slice(0, 20));
  assert.equal(ingest(db, root).added, 0);
  appendFileSync(f, JSON.stringify({ type: 'user', uuid: 'v2', sessionId: B, timestamp: at(44), message: { content: 'more' } }).slice(20) + '\n');
  assert.equal(ingest(db, root).added, 1);
});

test('re-ordered and truncated logs: a rewritten file replaces its events', () => {
  const { root, db } = setup();
  ingest(db, root);
  writeFileSync(join(root, `${B}.jsonl`), lines([...sessionB].reverse()));
  ingest(db, root);
  assert.equal(db.prepare('SELECT count(*) n FROM events WHERE session_id=?').get(B).n, 2);
  writeFileSync(join(root, `${B}.jsonl`), lines(sessionB.slice(0, 1)));
  ingest(db, root);
  assert.equal(db.prepare('SELECT count(*) n FROM events WHERE session_id=?').get(B).n, 1);
});

test('events round-trip to their source line', () => {
  const { root, db } = setup();
  ingest(db, root);
  const row = db.prepare("SELECT raw, line_no FROM events WHERE uuid='a2'").get();
  assert.equal(JSON.parse(row.raw).uuid, 'a2');
  assert.equal(row.line_no, 5);
});

test('coverage lists an unknown event type', () => {
  const { root, db } = setup();
  ingest(db, root);
  const c = coverage(db);
  assert.deepEqual(c.unknown_types.map((t) => t.type), ['brand-new-event']);
  assert.equal(c.unparsable_stored_raw, 1);
});

test('missions join A and B through continued-in and shared PR', () => {
  const { root, db } = setup();
  ingest(db, root);
  const m = missions(db);
  assert.equal(m.length, 1);
  assert.equal(m[0].sessions.length, 2);
});

test('human minutes: idle gap union, PR dedupe, flags, proxies', () => {
  const { root, db } = setup();
  ingest(db, root);
  const { summary, rows } = humanMinutes(db, { idle: 5 });
  assert.equal(summary.prs, 1);
  const pr = rows.find((r) => r.pr === 'o/x#7');
  // A: 0-1, 1-1, 1-3, 3-4 are within 5 min (=4 min); 4-20 and 20-40 are idle gaps; B: 42-43 and A 41-42-43
  assert.ok(pr.active_min >= 4 && pr.active_min <= 8, `active ${pr.active_min}`);
  assert.equal(pr.flagged_min, 0, 'work before the first pr-link is not ambiguous');
  assert.equal(pr.prompts, 4);
  assert.equal(pr.rejections, 1);
  assert.ok(pr.wall_clock_min >= 43);
  assert.match(summary.denominator, /linked/);
  const wide = humanMinutes(db, { idle: 15 }).summary.active_min_total;
  assert.ok(wide >= summary.active_min_total);
});

test('interventions per 100 calls', () => {
  const { root, db } = setup();
  ingest(db, root);
  const r = interventions(db);
  assert.equal(r.tool_calls, 2);
  assert.equal(r.signals, 2); // non-accept permission decision and the rejected call
  assert.equal(r.per_100_calls, 100);
  assert.match(r.note, /too few/);
});

test('export holds no message text', () => {
  const { root, db } = setup();
  ingest(db, root);
  const s = JSON.stringify(exportCounts(db));
  assert.ok(!s.includes(MARK));
  assert.ok(!s.includes('please do'));
  assert.ok(!s.includes(root));
});

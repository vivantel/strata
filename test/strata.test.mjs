import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db.mjs';
import { ingest } from '../src/ingest.mjs';
import { humanMinutes, interventions, coverage, exportCounts, missions, likeOf, setAlias } from '../src/queries.mjs';

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
  const row = db.prepare("SELECT r.raw, e.line_no FROM events e JOIN raw_events r ON r.event_id=e.id WHERE e.uuid='a2'").get();
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

test('a rejected call is counted when the tool result content is an array of text blocks', () => {
  const root = mkdtempSync(join(tmpdir(), 'strata-'));
  const S = 'cccccccc-0000-4000-8000-000000000003';
  writeFileSync(join(root, `${S}.jsonl`), lines([
    { type: 'assistant', uuid: 'a1', sessionId: S, timestamp: at(0), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } },
    { type: 'user', uuid: 'u1', sessionId: S, timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: "The user doesn't want to proceed" }] }] } },
  ]));
  const db = open(':memory:');
  ingest(db, root);
  assert.equal(interventions(db).signals, 1);
});

test('a snapshot that misses a linked PR reports how many PRs it left out', () => {
  const { root, db } = setup();
  ingest(db, root);
  db.prepare('INSERT INTO prs(repo,num,state,merged_at) VALUES(?,?,?,?)').run('o/other', 1, 'MERGED', T0);
  const { summary } = humanMinutes(db, { idle: 5 });
  assert.equal(summary.prs, 0);
  assert.equal(summary.unsnapshotted_prs, 1);
  assert.match(summary.warning, /1 linked PRs are not in the gh snapshot/);
});

test('the CLI refuses a non-numeric option and a --user that matches no archive folder', () => {
  const { root } = setup();
  const dbf = join(root, 'i.sqlite');
  const run = (...a) => spawnSync(process.execPath, [new URL('../bin/strata.mjs', import.meta.url).pathname, ...a, '--db', dbf], { encoding: 'utf8' });
  assert.equal(run('ingest', '--root', root).status, 0);
  const bad = run('sample', '--n', 'abc');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--n needs a positive number/);
  assert.equal(run('query', 'human-minutes-per-merged-pr', '--idle-min').status, 2);
  const nobody = run('query', 'human-minutes-per-merged-pr', '--user', 'bob');
  assert.equal(nobody.status, 2);
  assert.match(nobody.stderr, /no indexed file sits under/);
});

test('a repo alias makes links under the old name count as the new repo, without rewriting them', () => {
  const root = mkdtempSync(join(tmpdir(), 'strata-'));
  const S = 'cccccccc-0000-4000-8000-000000000003', S2 = 'dddddddd-0000-4000-8000-000000000004';
  const mk = (sid, repo, t) => [
    { type: 'user', uuid: `u-${sid}`, sessionId: sid, timestamp: at(t), message: { role: 'user', content: 'hi' } },
    { type: 'pr-link', sessionId: sid, prNumber: 5, prRepository: repo, timestamp: at(t + 1) }];
  writeFileSync(join(root, `${S}.jsonl`), lines(mk(S, 'o/old', 0)));
  writeFileSync(join(root, `${S2}.jsonl`), lines(mk(S2, 'o/new', 100)));
  const db = open(':memory:'); ingest(db, root);
  assert.equal(humanMinutes(db, { idle: 5 }).summary.prs, 2);
  setAlias(db, 'o/old', 'o/new');
  assert.equal(humanMinutes(db, { idle: 5 }).summary.prs, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE pr_repo='o/old'").get().n, 1);
  setAlias(db, 'o/old', null);
  assert.equal(humanMinutes(db, { idle: 5 }).summary.prs, 2);
});

test('a file outside the current root is not rotated; a vanished one is, and a returned one is ok again', () => {
  const r1 = mkdtempSync(join(tmpdir(), 'strata-')), r2 = mkdtempSync(join(tmpdir(), 'strata-'));
  const S1 = 'dddddddd-0000-4000-8000-000000000004', S2 = 'eeeeeeee-0000-4000-8000-000000000005';
  const f1 = join(r1, `${S1}.jsonl`);
  writeFileSync(f1, lines([{ type: 'user', uuid: 'x1', sessionId: S1, timestamp: at(0), message: { role: 'user', content: 'a' } }]));
  writeFileSync(join(r2, `${S2}.jsonl`), lines([{ type: 'user', uuid: 'y1', sessionId: S2, timestamp: at(0), message: { role: 'user', content: 'b' } }]));
  const db = open(':memory:');
  const rotated = () => db.prepare("SELECT count(*) n FROM files WHERE status='rotated'").get().n;
  ingest(db, r1); ingest(db, r2); ingest(db, r1);
  assert.equal(rotated(), 0, 'files that still exist elsewhere are not rotated');
  const saved = join(r1, 'saved.txt');
  writeFileSync(saved, lines([{ type: 'user', uuid: 'x1', sessionId: S1, timestamp: at(0), message: { role: 'user', content: 'a' } }]));
  rmSync(f1);
  ingest(db, r1);
  assert.equal(rotated(), 1, 'a vanished file is rotated');
  writeFileSync(f1, readFileSyncText(saved));
  ingest(db, r1);
  assert.equal(rotated(), 0, 'a file that returns unchanged is ok again');
});
const readFileSyncText = (p) => readFileSync(p, 'utf8');

test('--user finds a session whose events deduped to a file outside that account; LIKE text is literal', () => {
  const root = mkdtempSync(join(tmpdir(), 'strata-'));
  mkdirSync(join(root, 'live')); mkdirSync(join(root, 'archive/bob'), { recursive: true });
  const S = 'ffffffff-0000-4000-8000-000000000006';
  const body = lines([{ type: 'user', uuid: 'q1', sessionId: S, timestamp: at(0), cwd: '/r', message: { role: 'user', content: 'hi' } }, { type: 'pr-link', sessionId: S, prNumber: 3, prRepository: 'o/y', timestamp: at(1) }]);
  writeFileSync(join(root, 'live', `${S}.jsonl`), body);
  writeFileSync(join(root, 'archive/bob', `${S}.jsonl`), body);
  const db = open(':memory:');
  ingest(db, join(root, 'live')); ingest(db, join(root, 'archive'));
  assert.equal(missions(db, { user: 'bob' }).length, 1, 'the archive copy counts even though its events deduped');
  assert.equal(missions(db, { user: 'b_b' }).length, 0, '_ is not a wildcard');
  assert.equal(likeOf('a_b%c\\d'), '%a\\_b\\%c\\\\d%');
});

test('a log rewritten to a longer file with the same first 4 KiB is read again, not appended to', () => {
  const root = mkdtempSync(join(tmpdir(), 'strata-'));
  const S = '99999999-0000-4000-8000-000000000007';
  const pad = 'p'.repeat(5000);
  const ev = (u, c) => ({ type: 'user', uuid: u, sessionId: S, timestamp: at(0), message: { role: 'user', content: c } });
  const f = join(root, `${S}.jsonl`);
  writeFileSync(f, lines([ev('a1', pad), ev('a2', 'old second')]));
  const db = open(':memory:');
  ingest(db, root);
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n, 2);
  // same head (the 5000-byte first event), different and longer tail
  writeFileSync(f, lines([ev('a1', pad), ev('b2', 'new second, rewritten and longer than before'), ev('b3', 'third')]));
  ingest(db, root);
  const uuids = db.prepare('SELECT uuid FROM events ORDER BY line_no').all().map((r) => r.uuid);
  assert.deepEqual(uuids, ['a1', 'b2', 'b3'], 'stale events from the old content are gone');
});

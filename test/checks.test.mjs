import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db.mjs';
import { ingest } from '../src/ingest.mjs';
import { humanMinutes } from '../src/queries.mjs';
import { verify, canary, sample } from '../src/checks.mjs';

const now = Date.now();
const at = (min) => new Date(now - 3600000 + min * 60000).toISOString();
const S = 'cccccccc-0000-4000-8000-000000000003';
const ev = [
  { type: 'user', uuid: 'a', sessionId: S, timestamp: at(0), message: { content: 'start' } },
  { type: 'user', uuid: 'b', sessionId: S, timestamp: at(2), message: { content: 'next' } },
  { type: 'pr-link', sessionId: S, prNumber: 1, prRepository: 'o/x', timestamp: at(3) },
  { type: 'user', uuid: 'c', sessionId: S, timestamp: at(5), message: { content: 'more' } },
  { type: 'pr-link', sessionId: S, prNumber: 2, prRepository: 'o/x', timestamp: at(6) },
  { type: 'user', uuid: 'd', sessionId: S, timestamp: at(8), message: { content: 'end' } }
];

function setup(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'strata-c-'));
  const body = [...ev, ...extra].map((x) => JSON.stringify(x)).join('\n') + '\n';
  // a blank line and an exact duplicate: both must be accounted for by verify
  writeFileSync(join(root, `${S}.jsonl`), body + '\n' + JSON.stringify(ev[0]) + '\n');
  const db = open(':memory:'); ingest(db, root); return db;
}

test('verify accounts for every line: only blank and duplicate lines lack an event', () => {
  const db = setup();
  const v = verify(db);
  assert.equal(v.lines, 8);            // 6 events + blank? the blank line counts as a line
  assert.equal(v.events, 6);
  assert.equal(v.lines_without_own_event, 2);
  assert.equal(v.files_with_unread_tail, 0);
});

test('canary fails on an unclassified recent event type and passes otherwise', () => {
  assert.equal(canary(setup(), { days: 1 }).ok, true);
  const c = canary(setup([{ type: 'brand-new', sessionId: S, uuid: 'n', timestamp: at(9) }]), { days: 1 });
  assert.equal(c.ok, false);
  assert.deepEqual(c.unknown.map((u) => u.type), ['brand-new']);
});

test('equal-split sensitivity divides a multi-PR session across its PRs', () => {
  const db = setup();
  const { rows, summary } = humanMinutes(db, { idle: 5 });
  const sum = rows.filter((r) => r.pr !== 'no-pr').reduce((a, r) => a + r.equal_split_min, 0);
  assert.ok(Math.abs(sum - 8) < 0.01, `equal split should hold all 8 minutes, got ${sum}`);
  assert.equal(summary.flagged_share, 1); // the whole session links two PRs
  assert.ok(summary.equal_split_sensitivity.active_min_per_pr > 0);
});

test('sample returns ids and counts, no text', () => {
  const s = JSON.stringify(sample(setup(), { n: 5 }));
  assert.ok(!s.includes('start') && !s.includes('more'));
});

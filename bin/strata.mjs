#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.mjs';
import { ingest } from '../src/ingest.mjs';
import { humanMinutes, interventions, coverage, exportCounts, missions, likeOf } from '../src/queries.mjs';
import { verify, sample, canary } from '../src/checks.mjs';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; opt[k] = v; } else pos.push(args[i]);
}
// A numeric option must be a positive number; a bare flag or text is a usage error, never a silent default.
const num = (name, dflt) => {
  if (opt[name] === undefined) return dflt;
  const v = Number(opt[name]);
  if (opt[name] === true || !Number.isFinite(v) || v <= 0) { console.error(`strata: --${name} needs a positive number, got ${opt[name] === true ? 'nothing' : JSON.stringify(opt[name])}`); process.exit(2); }
  return v;
};
const home = homedir();
const dbPath = opt.db || join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'strata/index.sqlite');
const root = opt.root || join(home, '.claude/projects');
const out = (x) => console.log(JSON.stringify(x, null, 2));

const help = `strata <command>
  ingest [--root DIR] [--db FILE]        read Claude Code logs into the local index (incremental)
  coverage                               every event type: classified, ignored or UNKNOWN
  query human-minutes-per-merged-pr [--repo R] [--user U] [--idle-min N] [--by week] [--rows]
  query interventions-per-100-calls [--repo R]
  query missions [--repo R]
  snapshot --file prs.json | --gh REPO   merge state per PR (the only network use is --gh)
  export [--repo R]                      counts and flags only, no message text
  verify                                 every log line has an event, or is a counted duplicate
  canary [--days N]                      exit 1 if recent logs hold an unclassified event type (format drift)
  sample [--n 20] [--repo R]             ids and counts for the owner's hand check, no text
  status

Archive of every user's logs on this box: sudo sh scripts/archive.sh, then ingest --root <archive>.`;

if (!cmd || cmd === 'help' || opt.help) { console.log(help); process.exit(cmd ? 0 : 1); }
const db = open(dbPath);
if (!opt.user && ['query', 'export', 'sample'].includes(cmd)) {
  const users = db.prepare("SELECT DISTINCT substr(path, instr(path,'/archive/')+9, instr(substr(path, instr(path,'/archive/')+9),'/')-1) u FROM files WHERE path LIKE '%/archive/%'").all().map((r) => r.u);
  if (users.length > 1) console.error(`strata: the index holds several accounts (${users.join(', ')}); pass --user <name> or the figures mix people`);
}
if (opt.user && ['query', 'export', 'sample'].includes(cmd) && !db.prepare("SELECT 1 FROM files WHERE path LIKE ? ESCAPE '\\' LIMIT 1").get(likeOf(`/archive/${opt.user}/`))) {
  console.error(`strata: no indexed file sits under .../archive/${opt.user}/ (--user needs an archive laid out as archive/<user>/; check the name and the archive path)`);
  process.exit(2);
}
if (cmd === 'ingest') out(ingest(db, root));
else if (cmd === 'coverage') out(coverage(db));
else if (cmd === 'status') out({ db: dbPath, events: db.prepare('SELECT count(*) n FROM events').get().n, files: db.prepare('SELECT count(*) n FROM files').get().n, rotated: db.prepare("SELECT count(*) n FROM files WHERE status='rotated'").get().n });
else if (cmd === 'verify') out(verify(db));
else if (cmd === 'sample') out(sample(db, { n: num('n', 20), repo: opt.repo, user: opt.user }));
else if (cmd === 'canary') { const r = canary(db, { days: num('days', 14) }); out(r); if (!r.ok) process.exit(1); }
else if (cmd === 'export') out(exportCounts(db, { repo: opt.repo, user: opt.user }));
else if (cmd === 'query') {
  const name = pos[0];
  if (name === 'human-minutes-per-merged-pr') {
    const idle = num('idle-min', 5);
    const r = humanMinutes(db, { idle, repo: opt.repo, user: opt.user, by: opt.by });
    const others = [2, 5, 15].filter((x) => x !== idle).map((x) => { const s = humanMinutes(db, { idle: x, repo: opt.repo, user: opt.user }).summary; return { idle_min: x, active_min_per_pr: s.active_min_per_pr, trimmed_mean_active_min: s.trimmed_mean_active_min }; });
    out(opt.rows ? { ...r, sensitivity: others } : { summary: r.summary, sensitivity: others });
  } else if (name === 'interventions-per-100-calls') out(interventions(db, { repo: opt.repo, user: opt.user }));
  else if (name === 'missions') out(missions(db, { repo: opt.repo, user: opt.user }).map((m) => ({ id: m.id, sessions: m.sessions.length, joins: m.joins })));
  else { console.error(`unknown query ${name}\n${help}`); process.exit(2); }
} else if (cmd === 'snapshot') {
  let list;
  if (opt.file) list = JSON.parse(readFileSync(opt.file, 'utf8'));
  else if (opt.gh) {
    const raw = execFileSync('gh', ['pr', 'list', '-R', opt.gh, '--state', 'all', '--limit', '1000', '--json', 'number,state,additions,deletions,mergedAt'], { encoding: 'utf8' });
    list = JSON.parse(raw).map((p) => ({ repo: opt.gh, ...p }));
  } else { console.error('snapshot needs --file or --gh'); process.exit(2); }
  const ins = db.prepare('INSERT OR REPLACE INTO prs(repo,num,state,additions,deletions,merged_at,ci,reverted) VALUES(?,?,?,?,?,?,?,?)');
  for (const p of list) ins.run(p.repo, p.number, p.state ?? null, p.additions ?? null, p.deletions ?? null, p.mergedAt ? Date.parse(p.mergedAt) : null, p.ci ?? null, p.reverted ? 1 : 0);
  out({ prs: list.length });
} else { console.error(help); process.exit(2); }

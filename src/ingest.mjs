// Incremental, idempotent ingest. A file is keyed by (path, size, hash of its first 4 KiB) plus a byte offset.
import { openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { discover, normalize } from './adapter-claude.mjs';
import { tx } from './db.mjs';

const sha = (b) => createHash('sha1').update(b).digest('hex');
const PREFIX = 4096;

// Hash of the window that ends at `end` (up to 4 KiB): a rewrite that keeps the head and the length still changes it.
function tailOf(path, end) {
  const len = Math.min(PREFIX, end);
  if (!len) return { tail_hash: sha(Buffer.alloc(0)), tail_len: 0 };
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(len);
    let n = 0;
    while (n < len) { const r = readSync(fd, b, n, len - n, end - len + n); if (!r) break; n += r; }
    return { tail_hash: sha(b.subarray(0, n)), tail_len: len };
  } finally { closeSync(fd); }
}

function readRange(path, from, plen = PREFIX) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(plen, size));
    readSync(fd, head, 0, head.length, 0);
    const buf = Buffer.alloc(Math.max(0, size - from));
    let n = 0;
    while (n < buf.length) { const r = readSync(fd, buf, n, buf.length - n, from + n); if (!r) break; n += r; }
    return { size, prefix: sha(head), buf: buf.subarray(0, n) };
  } finally { closeSync(fd); }
}

export function ingestFile(db, path) {
  const rec = db.prepare('SELECT * FROM files WHERE path=?').get(path);
  let from = rec ? rec.byte_offset : 0;
  let lineBase = rec ? rec.lines : 0;
  let { size, prefix, buf } = readRange(path, from, rec ? rec.prefix_len : PREFIX);
  const tailChanged = rec && rec.tail_len > 0 && from >= rec.tail_len && tailOf(path, rec.byte_offset).tail_hash !== rec.tail_hash;
  if (rec && (size < rec.size || tailChanged || (rec.prefix_len > 0 && prefix !== rec.prefix_hash))) {
    // rewritten or truncated: drop this file's events and read it again
    db.prepare('DELETE FROM raw_events WHERE event_id IN (SELECT id FROM events WHERE file=?)').run(path);
    db.prepare('DELETE FROM events WHERE file=?').run(path);
    db.prepare('DELETE FROM session_files WHERE file=?').run(path);
    from = 0; lineBase = 0; ({ size, prefix, buf } = readRange(path, 0));
  } else if (rec && size === rec.size && from === rec.byte_offset) {
    // unchanged, and present again if it had been marked rotated
    if (rec.status !== 'ok') db.prepare("UPDATE files SET status='ok' WHERE path=?").run(path);
    return { added: 0, lines: 0 };
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO events(file,line_no,byte_offset,session_id,uuid,hash,type,kind,ts,sidechain,branch,cwd,
    owner_prompt,prompt_len,interrupted,n_tool_use,tool_use_ids,rejected,perm,hook_err,pr_repo,pr_num,link_to)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insSf = db.prepare('INSERT OR IGNORE INTO session_files(session_id, file) VALUES(?, ?)');
  const insRaw = db.prepare('INSERT INTO raw_events(event_id, raw) VALUES(?, ?)');
  const lastNl = buf.lastIndexOf(0x0a);
  const complete = lastNl < 0 ? 0 : lastNl + 1; // a partial last line waits for the next ingest
  let added = 0, lines = 0, pos = 0;
  const prefixLen = Math.min(PREFIX, from + complete);
  const prefixFinal = prefixLen ? readRange(path, 0, prefixLen).prefix : sha(Buffer.alloc(0));
  tx(db, () => {
    while (pos < complete) {
      let end = buf.indexOf(0x0a, pos); if (end < 0 || end >= complete) end = complete - 1;
      const raw = buf.subarray(pos, end).toString('utf8');
      lines++;
      if (raw.trim()) {
        let row;
        try { const o = JSON.parse(raw); row = (o && typeof o === 'object') ? normalize(o) : null; } catch { row = null; }
        if (!row) row = { session_id: null, uuid: null, type: null, kind: 'unparsable', ts: null, sidechain: 0, branch: null, cwd: null,
          owner_prompt: 0, prompt_len: 0, interrupted: 0, n_tool_use: 0, tool_use_ids: null, rejected: 0, perm: null, hook_err: 0,
          pr_repo: null, pr_num: null, link_to: null };
        // a subfolder file without a sessionId of its own keeps the folder's session
        if (!row.session_id) row.session_id = sessionFromPath(path);
        if (row.session_id) insSf.run(row.session_id, path);
        const r = ins.run(path, lineBase + lines, from + pos, row.session_id, row.uuid, sha(raw), row.type, row.kind, row.ts, row.sidechain,
          row.branch, row.cwd, row.owner_prompt, row.prompt_len, row.interrupted, row.n_tool_use, row.tool_use_ids, row.rejected,
          row.perm, row.hook_err, row.pr_repo, row.pr_num, row.link_to);
        if (Number(r.changes)) { insRaw.run(r.lastInsertRowid, raw); added++; }
      }
      pos = end + 1;
    }
    const tail = tailOf(path, from + complete);
    db.prepare(`INSERT INTO files(path,size,prefix_hash,prefix_len,byte_offset,lines,status,tail_hash,tail_len) VALUES(?,?,?,?,?,?,'ok',?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size,prefix_hash=excluded.prefix_hash,prefix_len=excluded.prefix_len,byte_offset=excluded.byte_offset,lines=excluded.lines,status='ok',tail_hash=excluded.tail_hash,tail_len=excluded.tail_len`)
      .run(path, size, prefixFinal, prefixLen, from + complete, lineBase + lines, tail.tail_hash, tail.tail_len);
  });
  return { added, lines };
}

function sessionFromPath(p) {
  const m = p.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  return m ? m[1] : null;
}

export function ingest(db, root) {
  const files = discover(root);
  let added = 0, lines = 0;
  for (const f of files) { const r = ingestFile(db, f); added += r.added; lines += r.lines; }
  // a file that vanished from disk is rotated, never deleted from the index; a file outside this root that still exists is left alone
  for (const r of db.prepare('SELECT path FROM files').all()) {
    if (!existsSync(r.path)) db.prepare("UPDATE files SET status='rotated' WHERE path=?").run(r.path);
  }
  return { files: files.length, added, lines };
}

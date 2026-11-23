// Host adapter for Claude Code JSONL: discover files, normalize one line into an event row.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Event types classified so far (R1 found 28). Anything else is reported by `coverage`.
export const KNOWN_TYPES = new Set([
  'user', 'assistant', 'system', 'attachment', 'permission-mode', 'mode', 'cost-state', 'pr-link',
  'queue-operation', 'ai-title', 'file-history-snapshot', 'atis-latch', 'last-prompt',
  'api-request-shape', 'api-request-blob', 'api-request', 'continued-in', 'derived-from',
  'summary', 'custom-title', 'agent-name', 'progress', 'tag', 'worktree-state',
  'data-flow-records', 'data-flow-incomplete', 'tools-used', 'file-history-delta', 'session-owner', 'fork-context-ref',
  'frame-link', 'artifact-autoreact-ledger', 'artifact-comment-monitor'
]);
// Types that carry no meter signal; classified as ignored on purpose.
export const IGNORED_TYPES = new Set([
  'file-history-snapshot', 'atis-latch', 'last-prompt', 'api-request-shape', 'api-request-blob',
  'api-request', 'ai-title', 'mode', 'permission-mode', 'summary', 'custom-title', 'agent-name', 'tag', 'worktree-state', 'progress',
  'data-flow-records', 'data-flow-incomplete', 'tools-used', 'file-history-delta', 'session-owner', 'fork-context-ref',
  'frame-link', 'artifact-autoreact-ledger', 'artifact-comment-monitor'
]);

export function discover(root) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}
export const sizeOf = (p) => statSync(p).size;

const DEFAULT_BRANCHES = new Set(['', 'HEAD', 'main', 'master', 'develop', 'dev']);
export const isDefaultBranch = (b) => DEFAULT_BRANCHES.has(b || '');

const blocks = (c) => (Array.isArray(c) ? c : []);

function humanText(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else {
    const b = blocks(c);
    if (b.some((x) => x?.type === 'tool_result')) return null;
    const t = b.filter((x) => x?.type === 'text').map((x) => x.text || '');
    if (t.length) text = t.join('\n');
  }
  if (text == null) return null;
  if (/^\s*<(local-command|system-reminder|command-name|task-notification|agent-message)/.test(text)) return null;
  return text;
}

// Returns the row to store, or null for a line that is not an object (stored raw by the caller).
export function normalize(o) {
  const row = {
    session_id: o.sessionId ?? null, uuid: o.uuid ?? null, type: o.type ?? null, kind: null,
    ts: o.timestamp ? Date.parse(o.timestamp) || null : null,
    sidechain: o.isSidechain ? 1 : 0, branch: o.gitBranch ?? null, cwd: o.cwd ?? null,
    owner_prompt: 0, prompt_len: 0, interrupted: 0, n_tool_use: 0, tool_use_ids: null,
    rejected: 0, perm: null, hook_err: 0, pr_repo: null, pr_num: null, link_to: null
  };
  const text = humanText(o);
  if (text != null) {
    if (/^\[Request interrupted by user/.test(text)) { row.interrupted = 1; row.kind = 'interrupt'; }
    else { row.owner_prompt = 1; row.prompt_len = text.length; row.kind = 'prompt'; }
  }
  if (o.type === 'assistant') {
    const ids = blocks(o.message?.content).filter((x) => x?.type === 'tool_use' && x.id).map((x) => x.id);
    row.n_tool_use = ids.length;
    row.tool_use_ids = ids.length ? ids.join(',') : null;
  }
  if (o.type === 'user' && o.permissionDecision) row.perm = o.permissionDecision.decision ?? 'unknown';
  if (o.type === 'user') {
    for (const b of blocks(o.message?.content)) {
      // content is a string, or an array of text blocks
      const text = typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '';
      if (b?.type === 'tool_result' && b.is_error && /doesn't want to proceed|was rejected|user rejected/i.test(text)) row.rejected = 1;
    }
  }
  if (Array.isArray(o.hookErrors) && o.hookErrors.length) row.hook_err = o.hookErrors.length;
  if (o.type === 'pr-link') { row.pr_repo = o.prRepository ?? null; row.pr_num = o.prNumber ?? null; row.kind = 'pr-link'; }
  if (o.type === 'continued-in') row.link_to = o.continuedInSessionId ?? null;
  if (o.type === 'derived-from') row.link_to = (o.sessions || []).map((s) => s.id).filter(Boolean).join(',') || null;
  return row;
}

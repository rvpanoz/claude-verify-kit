// Shared helpers for the Claude verification kit.
// Everything here is plain Node (>=18), no dependencies.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KIT_DIR = path.join(os.homedir(), '.claude', 'verification');
export const GATE_LOG = path.join(KIT_DIR, 'gate.log');
export const KINDS = ['verify', 'review'];

// ---------- process helpers ----------

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return { code: r.status ?? (r.error ? 1 : 0), out: r.stdout || '', err: r.stderr || '', error: r.error };
}

export function git(args, cwd) {
  return sh('git', args, { cwd });
}

export function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ---------- repo discovery ----------

export function repoInfo(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return null;
  const root = top.out.trim();
  const gd = git(['rev-parse', '--absolute-git-dir'], root);
  const gitDir = gd.out.trim();
  const stateDir = path.join(gitDir, 'claude-verify');
  const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD'], root).code === 0;
  const head = hasHead ? git(['rev-parse', 'HEAD'], root).out.trim() : null;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).out.trim() || 'detached';
  // The commit ledger lives in the common git dir so every worktree of the repo shares it.
  const commonDir = path.resolve(root, git(['rev-parse', '--git-common-dir'], root).out.trim() || gitDir);
  const ledger = path.join(commonDir, 'claude-verify', 'commits.jsonl');
  return { root, gitDir, stateDir, hasHead, head, branch, ledger, id: repoId(root) };
}

// Stable id for the private per-repo folder: origin URL if there is one, else folder name.
export function repoId(root) {
  const url = git(['config', '--get', 'remote.origin.url'], root).out.trim();
  const base = url
    ? url.replace(/^[a-z]+:\/\//i, '').replace(/^git@/, '').replace(/\.git$/, '')
    : path.basename(root);
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

export function privateRepoDir(info) {
  return path.join(KIT_DIR, 'repos', info.id);
}

// Default branch tip used as the "base" for reviews (origin/HEAD, then main/master).
export function baseRef(info) {
  const candidates = [];
  const sym = git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], info.root).out.trim();
  if (sym) candidates.push(sym);
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '-q', ref], info.root).code === 0) {
      const mb = git(['merge-base', 'HEAD', ref], info.root);
      const tip = git(['rev-parse', ref], info.root).out.trim();
      // sha = merge-base (what the diff is against), tip = latest default branch (where the rules are read from)
      if (mb.code === 0 && mb.out.trim()) return { ref, sha: mb.out.trim(), tip };
    }
  }
  return info.hasHead ? { ref: 'HEAD', sha: info.head, tip: info.head } : null;
}

// ---------- state ----------

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function appendLog(entry) {
  try {
    ensureDir(KIT_DIR);
    fs.appendFileSync(GATE_LOG, JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* logging is best effort */
  }
}

// ---------- fingerprint of the working tree vs HEAD ----------
// Same fingerprint before and after `git add`, so a verification recorded before staging
// still matches at commit time. Any edit afterwards changes it and makes the record stale.

export function changedState(info) {
  const diffArgs = info.hasHead
    ? ['diff', 'HEAD', '--binary', '--no-color', '--no-ext-diff']
    : ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'];
  const diff = git(diffArgs, info.root).out;
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], info.root)
    .out.split('\0')
    .filter(Boolean)
    .sort();
  return { diff, untracked };
}

export function fingerprint(info) {
  const { diff, untracked } = changedState(info);
  if (!diff && untracked.length === 0) return null; // clean tree
  const h = createHash('sha256');
  h.update(info.head || 'no-head');
  h.update('\0');
  h.update(diff);
  for (const f of untracked) {
    h.update('\0' + f + '\0');
    try {
      const st = fs.statSync(path.join(info.root, f));
      if (st.isFile() && st.size < 20 * 1024 * 1024) h.update(fs.readFileSync(path.join(info.root, f)));
      else h.update(String(st.size));
    } catch {
      /* vanished */
    }
  }
  return h.digest('hex').slice(0, 16);
}

// ---------- layered config & rule files ----------
// Lookup order for a repo-specific file:
//   1. committed in the repo at a fixed ref (HEAD for config, base branch for review rules),
//      never the working copy, so a change can't rewrite the checks that judge it
//   2. your private per-repo folder ~/.claude/verification/repos/<repo-id>/
//      (nothing gets committed to client repos)
//   3. kit defaults ~/.claude/verification/defaults/

export function showAtRef(info, ref, relPath) {
  if (!ref) return null;
  const r = git(['show', `${ref}:${relPath}`], info.root);
  return r.code === 0 ? r.out : null;
}

export function resolveFile(info, name, { ref } = {}) {
  const committedPaths = name === 'REVIEW.md' ? ['REVIEW.md', '.claude/REVIEW.md'] : [`.claude/${name}`];
  if (info && ref) {
    for (const p of committedPaths) {
      const c = showAtRef(info, ref, p);
      if (c != null) return { source: `${p} @ ${ref.slice(0, 12)} (committed)`, content: c };
    }
  }
  if (info) {
    const priv = path.join(privateRepoDir(info), name);
    if (fs.existsSync(priv)) return { source: priv, content: fs.readFileSync(priv, 'utf8') };
  }
  const def = path.join(KIT_DIR, 'defaults', name);
  if (fs.existsSync(def)) return { source: def + ' (kit default)', content: fs.readFileSync(def, 'utf8') };
  return null;
}

export function loadConfig(info) {
  const global = readJson(path.join(KIT_DIR, 'config.json'), {});
  let repo = {};
  if (info) {
    const f = resolveFile(info, 'verify.config.json', { ref: info.hasHead ? 'HEAD' : null });
    if (f && !f.source.endsWith('(kit default)')) {
      try {
        repo = JSON.parse(f.content);
      } catch {
        repo = {};
      }
    }
  }
  const cfg = {
    gate: 'observe',
    require: ['verify'],
    stopHook: true,
    maxStopRounds: 3,
    maxGateBlocks: 2,
    checkTimeoutSec: 240,
    fastChecks: null,
    ...global,
    ...repo,
  };
  if (process.env.CLAUDE_VERIFY_GATE) cfg.gate = process.env.CLAUDE_VERIFY_GATE;
  if (process.env.CLAUDE_VERIFY_STOP === 'off') cfg.stopHook = false;
  return cfg;
}

// ---------- fast checks (lint / typecheck / unit tests) ----------

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

export function packageManager(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

export function detectFastChecks(info, cfg) {
  if (Array.isArray(cfg.fastChecks)) return cfg.fastChecks;
  const pkgPath = path.join(info.root, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = readJson(pkgPath, {});
  const scripts = pkg.scripts || {};
  const pm = packageManager(info.root);
  const run = (s) => `${pm} run ${s}`;
  const checks = [];
  if (scripts.lint) checks.push({ name: 'lint', cmd: run('lint') });
  const tc = ['typecheck', 'type-check', 'tsc', 'check-types', 'types'].find((s) => scripts[s]);
  if (tc) checks.push({ name: 'typecheck', cmd: run(tc) });
  else if (fs.existsSync(path.join(info.root, 'tsconfig.json')) && fs.existsSync(path.join(info.root, 'node_modules', '.bin', 'tsc')))
    checks.push({ name: 'typecheck', cmd: 'npx --no-install tsc --noEmit' });
  const testScript = ['test:unit', 'test'].find((s) => scripts[s] && scripts[s].trim() !== NPM_DEFAULT_TEST);
  if (testScript) checks.push({ name: 'test', cmd: run(testScript) });
  return checks;
}

function tail(text, lines = 60) {
  const arr = text.trimEnd().split('\n');
  return (arr.length > lines ? ['…(truncated)', ...arr.slice(-lines)] : arr).join('\n');
}

export function runFastChecks(info, cfg, { only } = {}) {
  const checks = detectFastChecks(info, cfg).filter((c) => !only || only.includes(c.name));
  const results = [];
  for (const c of checks) {
    const started = Date.now();
    const r = sh(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', c.cmd] : ['-c', c.cmd], {
      cwd: info.root,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
      timeout: (cfg.checkTimeoutSec || 240) * 1000,
    });
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    results.push({
      name: c.name,
      cmd: c.cmd,
      ok: r.code === 0 && !timedOut,
      timedOut,
      ms: Date.now() - started,
      output: tail((r.out || '') + (r.err ? '\n' + r.err : '')),
    });
  }
  return results;
}

// ---------- diff policy: things an agent shouldn't sneak in ----------
// A line can opt out with a `verify-allow: <reason>` comment.

const BLOCKING = [
  { re: /\b(?:it|test|describe|context)\.only\s*\(|\bf(?:it|describe)\s*\(/, why: 'focused test (.only/fit) silences the rest of the suite' },
  { re: /\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|test|describe)\s*\(|\btest\.fixme\s*\(/, why: 'skipped test; fix the cause instead of skipping' },
  { re: /\bjest\.retryTimes\s*\(|\bretries\s*:\s*[1-9]|\bretry\s*:\s*[1-9]/, why: 'retries hide flaky tests instead of fixing them' },
];
const WARNING = [
  { re: /\bwaitForTimeout\s*\(|\bsleep\s*\(\s*\d|setTimeout\s*\(\s*r(?:esolve)?\s*,\s*\d{3,}/, why: 'fixed sleep in a test; wait for a condition instead' },
  { re: /@ts-ignore|@ts-nocheck|eslint-disable(?!-next-line\s+\S+\s+--)/, why: 'suppressed type/lint error' },
];
const TEST_FILE = /(\.|\/|^)(test|spec|e2e|cy)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)(tests?|e2e|cypress|playwright)\/|playwright\.config|vitest\.config|jest\.config/;

export function diffPolicy(info) {
  const { diff, untracked } = changedState(info);
  const added = []; // {file, line}
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(4).replace(/^b\//, '');
    else if (l.startsWith('+') && !l.startsWith('+++') && file) added.push({ file, line: l.slice(1) });
  }
  for (const f of untracked) {
    try {
      const p = path.join(info.root, f);
      if (fs.statSync(p).size > 2 * 1024 * 1024) continue;
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) added.push({ file: f, line });
    } catch {
      /* ignore */
    }
  }
  const problems = [];
  const warnings = [];
  for (const { file: f, line } of added) {
    if (/verify-allow:/.test(line)) continue;
    const isTest = TEST_FILE.test(f);
    for (const rule of BLOCKING) if (isTest && rule.re.test(line)) problems.push(`${f}: ${line.trim().slice(0, 120)}  ← ${rule.why}`);
    for (const rule of WARNING) if ((isTest || rule.why.startsWith('suppressed')) && rule.re.test(line)) warnings.push(`${f}: ${line.trim().slice(0, 120)}  ← ${rule.why}`);
  }
  return { problems, warnings };
}

// ---------- verification records ----------

export function recordPath(info, kind) {
  return path.join(info.stateDir, `${kind}.json`);
}

export function freshKinds(info, fp = fingerprint(info)) {
  const fresh = [];
  for (const k of KINDS) {
    const rec = readJson(recordPath(info, k), null);
    if (rec && rec.result === 'pass' && fp && rec.fingerprint === fp) fresh.push(k);
  }
  return fresh;
}

// A waiver lets one exact working tree through the commit gate without verification
// (e.g. docs only). Any further edit changes the fingerprint and cancels it.
export function waiverPath(info) {
  return path.join(info.stateDir, 'waive.json');
}

export function waiverFor(info, fp = fingerprint(info)) {
  const w = readJson(waiverPath(info), null);
  return w && fp && w.fingerprint === fp ? w : null;
}

// ---------- commit detection ----------

// `git [-C dir] [-c k=v] ... commit ...`
const COMMIT_RE = /(?:^|[\s;&|(])git((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+commit\b/;

// Returns the directory a `git commit` in `command` runs in, or null if it isn't a commit.
export function commitTarget(command, cwd) {
  const m = String(command || '').match(COMMIT_RE);
  if (!m) return null;
  const dashC = (m[1] || '').match(/-C\s+("([^"]*)"|'([^']*)'|(\S+))/);
  return { cwd: dashC ? path.resolve(cwd, dashC[2] ?? dashC[3] ?? dashC[4]) : cwd };
}

// ---------- commit ledger ----------
// One JSON line per commit Claude made: which records were fresh, or the waiver reason.
// Nothing goes into the commit message.

export function pendingCommitPath(info) {
  return path.join(info.stateDir, 'pending-commit.json');
}

export function readLedger(info) {
  const bySha = new Map();
  const byTree = new Map();
  let raw = '';
  try {
    raw = fs.readFileSync(info.ledger, 'utf8');
  } catch {
    return { bySha, byTree };
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.sha) bySha.set(e.sha, e);
      if (e.tree) byTree.set(e.tree, e);
    } catch {
      /* skip bad line */
    }
  }
  return { bySha, byTree };
}

export function appendLedger(info, entry) {
  ensureDir(path.dirname(info.ledger));
  fs.appendFileSync(info.ledger, JSON.stringify(entry) + '\n');
}

// How a ledger entry counts in reports: verified (everything required was fresh), waived, or unverified.
// Entries without `missing` predate it: then any fresh record counts as verified.
export function entryKind(e) {
  if (e.waived) return 'waived';
  const ok = Array.isArray(e.missing) ? e.missing.length === 0 : (e.kinds || []).length > 0;
  return ok ? 'verified' : 'unverified';
}

// One-line description of how a commit was verified, for reports.
export function describeEntry(e) {
  const kinds = (e.kinds || []).join(', ');
  const kind = entryKind(e);
  if (kind === 'waived') return (kinds ? kinds + ' + ' : '') + 'waived: ' + e.waived;
  if (kind === 'verified') return kinds || 'nothing required';
  return kinds ? `${kinds} (missing ${e.missing.join(', ')})` : 'unverified';
}

// A pending entry older than this is from a commit that never ran (denied or rejected).
const PENDING_MAX_AGE_MS = 30 * 60 * 1000;

// Number of entries in this worktree's HEAD reflog (0 if it has none yet).
export function reflogLength(info) {
  const r = git(['log', '-g', '--format=%H', 'HEAD'], info.root);
  return r.code === 0 ? r.out.split('\n').filter(Boolean).length : 0;
}

// Called after a Bash command that ran `git commit`: writes a ledger entry for each commit the
// command made, i.e. each `commit*` entry added to this worktree's HEAD reflog since the gate
// recorded its length. Using the reflog (not just HEAD) keeps `git commit && git checkout other`
// or `&& git pull --rebase` from recording some other commit. Returns the number of entries written.
export function settlePending(info, sessionId) {
  const file = pendingCommitPath(info);
  const pending = readJson(file, null);
  if (!pending) return 0;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort */
  }
  if (sessionId && pending.session && pending.session !== sessionId) return 0;
  const since = Date.parse(pending.time);
  if (!since || Date.now() - since > PENDING_MAX_AGE_MS || !Number.isInteger(pending.reflogLength)) return 0;
  const r = git(['log', '-g', '--format=%H%x1f%T%x1f%gs', 'HEAD'], info.root);
  if (r.code !== 0) return 0;
  const lines = r.out.split('\n').filter(Boolean);
  const added = lines.slice(0, Math.max(0, lines.length - pending.reflogLength)); // newest first
  const known = readLedger(info).bySha;
  const made = [];
  for (const line of added) {
    const [sha, tree, subject] = line.split('\x1f');
    if (/^commit\b/.test(subject || '') && !known.has(sha)) made.push({ sha, tree });
  }
  for (const c of made.reverse()) {
    appendLedger(info, {
      sha: c.sha,
      tree: c.tree,
      kinds: pending.kinds || [],
      missing: pending.missing || [],
      waived: pending.waived || null,
      branch: info.branch,
      session: pending.session,
      time: new Date().toISOString(),
    });
  }
  return made.length;
}

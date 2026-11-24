#!/usr/bin/env node
// Claude Code "PreToolUse" hook (matcher: Bash): gates `git commit` commands Claude runs.
//
// Every commit Claude makes must carry a stamp trailer saying how it was verified:
//   Verified-By: verify, review            (kinds that passed for this exact working tree)
//   Verified-By: none - <reason>           (explicit, queryable opt-out)
// Modes: off | observe (log what would be blocked) | enforce (block).
// After `maxGateBlocks` blocks in one session the next commit is let through, so Claude can't get stuck.
// Commits you make yourself in a terminal are never touched.
import fs from 'node:fs';
import path from 'node:path';
import { git, readStdinJson, repoInfo, loadConfig, fingerprint, freshKinds, readJson, writeJson, appendLog, KINDS } from './lib.mjs';

const input = readStdinJson();
if (input.tool_name !== 'Bash') process.exit(0);
const command = String(input.tool_input?.command || '');

// `git [-C dir] [-c k=v] ... commit ...`
const COMMIT_RE = /(?:^|[\s;&|(])git((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+commit\b/;
const m = command.match(COMMIT_RE);
if (!m) process.exit(0);

let cwd = input.cwd || process.cwd();
const dashC = (m[1] || '').match(/-C\s+("([^"]*)"|'([^']*)'|(\S+))/);
if (dashC) cwd = path.resolve(cwd, dashC[2] ?? dashC[3] ?? dashC[4]);

const info = repoInfo(cwd);
if (!info) process.exit(0);
const cfg = loadConfig(info);
if (cfg.gate === 'off') process.exit(0);

// ---- find the commit message text ----
let message = command;
const fileArg = command.match(/\s(?:-F|--file)(?:\s+|=)("([^"]+)"|'([^']+)'|(\S+))/);
if (fileArg) {
  const f = fileArg[2] ?? fileArg[3] ?? fileArg[4];
  if (f !== '-') {
    try {
      message += '\n' + fs.readFileSync(path.resolve(cwd, f), 'utf8');
    } catch {
      /* unreadable */
    }
  }
}
if (/--amend\b/.test(command) && /--no-edit\b/.test(command)) {
  const r = git(['log', '-1', '--format=%B'], info.root);
  message += '\n' + r.out;
}

// ---- evaluate ----
const fp = fingerprint(info);
const fresh = fp ? freshKinds(info, fp) : [];
const required = (cfg.require || []).filter((k) => KINDS.includes(k));
const stamp = message.match(/Verified-By:\s*([^\n"'\\]*)/i);
const suggested = fresh.length ? `Verified-By: ${fresh.join(', ')}` : 'Verified-By: none - <why it was not verified>';

let problem = null;
if (!fp && !/--amend\b/.test(command)) {
  problem = null; // nothing to commit; let git say so
} else if (!stamp) {
  problem = `commit has no verification stamp. Add the trailer \`${suggested}\` as the last line of the message.`;
} else {
  const value = stamp[1].trim();
  if (/^none\b/i.test(value)) {
    if (!/^none\s*[-–—:(]\s*\S{3,}/i.test(value)) problem = 'a `Verified-By: none` stamp needs a reason, e.g. `Verified-By: none - docs only`.';
  } else {
    const claimed = value.split(/[\s,]+/).map((s) => s.toLowerCase()).filter(Boolean);
    const unknown = claimed.filter((k) => !KINDS.includes(k));
    const stale = claimed.filter((k) => KINDS.includes(k) && !fresh.includes(k));
    const missing = required.filter((k) => !fresh.includes(k));
    if (unknown.length) problem = `unknown stamp value(s): ${unknown.join(', ')}. Use ${KINDS.join(' / ')} or none - <reason>.`;
    else if (stale.length)
      problem =
        `stamp claims ${stale.join(', ')} but there is no passing record for the current working tree ` +
        `(it was never run, it failed, or files changed afterwards). Run /${stale[0] === 'verify' ? 'verify' : 'review-changes'} again.`;
    else if (missing.length)
      problem = `this repo requires ${missing.join(', ')} before committing. Run it, or stamp \`Verified-By: none - <reason>\`.`;
  }
}

const base = { repo: info.id, branch: info.branch, mode: cfg.gate, session: input.session_id, fresh, stamp: stamp?.[1]?.trim() ?? null };

const stateFile = path.join(info.stateDir, 'gate.json');
const state = { blocks: {}, ...readJson(stateFile, {}) };
const sid = input.session_id || 'unknown';

if (!problem) {
  appendLog({ ...base, decision: 'allow' });
  if (state.blocks[sid]) {
    state.blocks[sid] = 0; // a good commit resets the "let it through after N blocks" counter
    writeJson(stateFile, state);
  }
  process.exit(0);
}

if (cfg.gate !== 'enforce') {
  appendLog({ ...base, decision: 'would-block', problem });
  process.exit(0);
}

const blocks = state.blocks[sid] || 0;

if (blocks >= cfg.maxGateBlocks) {
  state.blocks[sid] = 0;
  writeJson(stateFile, state);
  appendLog({ ...base, decision: 'let-through', problem });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Commit gate let this through after ${blocks} blocks: ${problem}`,
      },
      systemMessage: `Commit gate let a commit through after ${blocks} blocks in this session: ${problem}`,
    }),
  );
  process.exit(0);
}

state.blocks[sid] = blocks + 1;
writeJson(stateFile, state);
appendLog({ ...base, decision: 'block', problem });
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Commit gate (enforce): ${problem}`,
    },
  }),
);

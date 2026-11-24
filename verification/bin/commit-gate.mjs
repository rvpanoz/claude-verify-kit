#!/usr/bin/env node
// Claude Code "PreToolUse" hook (matcher: Bash): gates `git commit` commands Claude runs.
//
// A commit goes through when the records the repo requires (default: verify) passed for this
// exact working tree, or when the tree was explicitly waived with `cv waive "<reason>"`.
// Nothing is added to the commit message: the outcome is written to a local ledger by the
// PostToolUse hook (post-commit.mjs) once the commit exists.
// Modes: off | observe (log what would be blocked) | enforce (block).
// After `maxGateBlocks` blocks in one session the next commit is let through, so Claude can't get stuck.
// Commits you make yourself in a terminal are never touched.
import fs from 'node:fs';
import path from 'node:path';
import {
  readStdinJson, repoInfo, loadConfig, fingerprint, freshKinds, waiverFor, commitTarget, readLedger,
  pendingCommitPath, reflogLength, readJson, writeJson, appendLog, KINDS,
} from './lib.mjs';

const CV = 'node ~/.claude/verification/bin/cv.mjs';

const input = readStdinJson();
if (input.tool_name !== 'Bash') process.exit(0);
const command = String(input.tool_input?.command || '');

const target = commitTarget(command, input.cwd || process.cwd());
if (!target) process.exit(0);

const info = repoInfo(target.cwd);
if (!info) process.exit(0);
const cfg = loadConfig(info);
if (cfg.gate === 'off') {
  fs.rmSync(pendingCommitPath(info), { force: true }); // don't let an old outcome attach to this commit
  process.exit(0);
}

// ---- evaluate ----
const amend = /--amend\b/.test(command);
const fp = fingerprint(info);
const fresh = fp ? freshKinds(info, fp) : [];
const waiver = fp ? waiverFor(info, fp) : null;
const required = (cfg.require || []).filter((k) => KINDS.includes(k));
const missing = required.filter((k) => !fresh.includes(k));

let problem = null;
if (fp && missing.length && !waiver) {
  problem =
    `this repo requires ${missing.join(' and ')} for the current working tree before committing ` +
    `(never run, failed, or files changed afterwards). Run /${missing[0] === 'verify' ? 'verify' : 'review-changes'}. ` +
    `If verification genuinely doesn't apply (docs, comments), run \`${CV} waive "<reason>"\` and tell the user. ` +
    `Don't add a Verified-By trailer to the message; the gate doesn't read it.`;
}

// What the ledger will say about this commit. A clean-tree amend (message reword) keeps whatever
// the commit it replaces had; with no entry for it (or a commit with no changes) nothing is recorded,
// so `cv report` falls back to the tree or an old-style trailer.
let outcome = fp ? { kinds: fresh, missing, waived: missing.length && waiver ? waiver.reason : null } : null;
if (!fp && amend && info.head) {
  const prev = readLedger(info).bySha.get(info.head);
  if (prev) outcome = { kinds: prev.kinds || [], missing: prev.missing, waived: prev.waived || null };
}

const sid = input.session_id || 'unknown';
const base = { repo: info.id, branch: info.branch, mode: cfg.gate, session: input.session_id, fresh, waived: outcome?.waived ?? null };

// Handed to post-commit.mjs, which records the commit SHA once it exists.
const recordPending = () => {
  if (outcome)
    writeJson(pendingCommitPath(info), {
      headBefore: info.head,
      reflogLength: reflogLength(info),
      session: sid,
      time: new Date().toISOString(),
      ...outcome,
    });
  else fs.rmSync(pendingCommitPath(info), { force: true });
};

const stateFile = path.join(info.stateDir, 'gate.json');
const state = { blocks: {}, ...readJson(stateFile, {}) };

if (!problem) {
  appendLog({ ...base, decision: 'allow' });
  recordPending();
  if (state.blocks[sid]) {
    state.blocks[sid] = 0; // a good commit resets the "let it through after N blocks" counter
    writeJson(stateFile, state);
  }
  process.exit(0);
}

if (cfg.gate !== 'enforce') {
  appendLog({ ...base, decision: 'would-block', problem });
  recordPending();
  process.exit(0);
}

const blocks = state.blocks[sid] || 0;

if (blocks >= cfg.maxGateBlocks) {
  state.blocks[sid] = 0;
  writeJson(stateFile, state);
  appendLog({ ...base, decision: 'let-through', problem });
  recordPending();
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

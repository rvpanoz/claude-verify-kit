#!/usr/bin/env node
// Claude Code "PostToolUse" and "PostToolUseFailure" hook (matcher: Bash): after a `git commit`
// Claude ran, write each new commit and how it was verified to the ledger
// (<git common dir>/claude-verify/commits.jsonl). The commit gate (commit-gate.mjs) leaves the
// verification outcome in pending-commit.json. Failures count too: in `git commit && git push`
// the commit exists even when the push fails.
import { readStdinJson, repoInfo, commitTarget, settlePending } from './lib.mjs';

const input = readStdinJson();
if (input.tool_name !== 'Bash') process.exit(0);

const target = commitTarget(input.tool_input?.command, input.cwd || process.cwd());
if (!target) process.exit(0);

const info = repoInfo(target.cwd);
if (!info) process.exit(0);

try {
  settlePending(info, input.session_id);
} catch {
  /* the ledger is best effort; never fail the tool call */
}

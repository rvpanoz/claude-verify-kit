#!/usr/bin/env node
// Claude Code "Stop" hook: when Claude finishes a turn with uncommitted changes,
// run the cheap checks (diff policy, lint, typecheck, unit tests).
// If something fails, Claude is sent back to fix it, at most `maxStopRounds` times
// in a row; after that it stops and the failure is handed to you.
import path from 'node:path';
import { readStdinJson, repoInfo, loadConfig, fingerprint, diffPolicy, runFastChecks, readJson, writeJson } from './lib.mjs';

const input = readStdinJson();
const info = repoInfo(input.cwd || process.cwd());
if (!info) process.exit(0);

const cfg = loadConfig(info);
if (!cfg.stopHook) process.exit(0);

const fp = fingerprint(info);
if (!fp) process.exit(0); // nothing changed, nothing to check

const stateFile = path.join(info.stateDir, 'stop.json');
const state = { lastPassFingerprint: null, deferred: {}, sessions: {}, acceptedFailing: {}, ...readJson(stateFile, {}) };
state.sessions ||= {};
const sid = input.session_id || 'unknown';
const sess = (state.sessions[sid] ||= { rounds: 0 });

const say = (obj) => {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
};

if (state.lastPassFingerprint === fp) process.exit(0); // this exact tree already passed
if (state.deferred && state.deferred[fp]) process.exit(0); // Claude deferred checks for this exact tree (cv defer)

const accepted = (state.acceptedFailing && state.acceptedFailing[info.head]) || {};
const policy = diffPolicy(info);
const results = runFastChecks(info, cfg);
const failing = results.filter((r) => !r.ok && !accepted[r.name]);

if (policy.problems.length === 0 && failing.length === 0) {
  state.lastPassFingerprint = fp;
  sess.rounds = 0;
  writeJson(stateFile, state);
  if (policy.warnings.length) {
    say({
      decision: 'block',
      reason:
        'Fast checks passed, but the diff adds things worth a second look. Fix them, or keep them with a ' +
        '`verify-allow: <reason>` comment on the line, then finish:\n' +
        policy.warnings.map((w) => '- ' + w).join('\n'),
    });
  }
  process.exit(0);
}

sess.rounds += 1;
writeJson(stateFile, state);

const report = [
  ...policy.problems.map((p) => `- diff policy: ${p}`),
  ...failing.map((r) => `### ${r.name} failed${r.timedOut ? ' (timed out)' : ''}: \`${r.cmd}\`\n\`\`\`\n${r.output}\n\`\`\``),
].join('\n');

if (sess.rounds > cfg.maxStopRounds) {
  // Give up and hand it to the human instead of looping forever.
  sess.rounds = 0;
  writeJson(stateFile, state);
  say({
    systemMessage: `Fast checks are still failing after ${cfg.maxStopRounds} rounds. This needs you:\n${report}`.slice(0, 6000),
  });
}

say({
  decision: 'block',
  reason:
    `Fast checks failed (round ${sess.rounds} of ${cfg.maxStopRounds}). Fix the root cause, don't skip, ` +
    `retry or weaken the test.\n` +
    `If you are stopping on purpose (asking the user something, work deliberately unfinished), run ` +
    `\`node ~/.claude/verification/bin/cv.mjs defer "<reason>"\` and tell the user why.\n` +
    `If a check was already failing before your change, confirm that (e.g. \`git stash -u\`, run it, \`git stash pop\`), then run ` +
    `\`node ~/.claude/verification/bin/cv.mjs accept-failing <check> "<reason>"\` and tell the user.\n\n` +
    report,
});

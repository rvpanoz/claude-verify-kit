#!/usr/bin/env node
// cv — command line for the Claude verification kit. Run from inside a git repo.
//   node ~/.claude/verification/bin/cv.mjs <command>
import fs from 'node:fs';
import path from 'node:path';
import {
  KIT_DIR, GATE_LOG, KINDS, git, repoInfo, loadConfig, fingerprint, freshKinds, runFastChecks, detectFastChecks,
  diffPolicy, resolveFile, baseRef, privateRepoDir, readJson, writeJson, ensureDir, recordPath, waiverFor, waiverPath,
  readLedger, describeEntry, entryKind,
} from './lib.mjs';

const [cmd = 'help', ...args] = process.argv.slice(2);
const info = repoInfo();

// What the commit gate would do with the current tree, in one line.
function gateVerdict(cfg, fp) {
  if (!fp) return 'nothing to commit';
  const fresh = freshKinds(info, fp);
  const missing = (cfg.require || []).filter((k) => KINDS.includes(k) && !fresh.includes(k));
  if (!missing.length) return `would allow (${fresh.join(', ') || 'nothing required'})`;
  const w = waiverFor(info, fp);
  if (w) return `would allow (waived: ${w.reason})`;
  return `would ${cfg.gate === 'enforce' ? 'block' : 'log a block'}: needs ${missing.join(', ')}, or cv waive "<reason>"`;
}

function needRepo() {
  if (!info) {
    console.error(`cv: '${cmd}' must be run inside a git repository. cd into your project folder first, e.g. cd ~/code/my-project && cv ${cmd}`);
    process.exit(2);
  }
}

const commands = {
  help() {
    console.log(`cv — Claude verification kit. Run repo commands from inside the project folder.

First time in a repo:  cv init, then ask Claude to fill in the verify notes. Check with: cv where / cv status

  status                       working-tree fingerprint, fresh verify/review records, gate mode
  checks [name...]             run the fast checks (lint/typecheck/test) + diff policy now
  record <verify|review> <pass|fail> [note]
                               record a result for the current working tree (used by the skills)
  waive <reason>               let the commit gate pass this exact tree without verification (e.g. docs only)
  notes                        print this repo's verify notes (how to boot/drive the app, feature map)
  rules                        print review rules: REVIEW.md from the base branch + reliability checklist
  diff                         print the diff under review (base branch merge-base → working tree)
  review-path                  path for the next review report on this branch (+ earlier rounds)
  defer <reason>               let Claude stop without passing fast checks, for this exact tree only
  accept-failing <check> <reason>
                               ignore a check that already fails on HEAD (until HEAD moves)
  init                         create this repo's private notes/rules/config from the templates
  where                        show where every file for this repo is read from
  gate [off|observe|enforce]   show or set the global commit-gate mode
  report [n]                   how the last n commits (default 30) were verified (from the commit ledger)
  log [n]                      last n gate decisions (default 20), incl. what observe mode would block`);
  },

  status() {
    needRepo();
    const cfg = loadConfig(info);
    const fp = fingerprint(info);
    console.log(`repo         ${info.id}  (${info.root})`);
    console.log(`branch       ${info.branch}`);
    console.log(`working tree ${fp ? 'changed, fingerprint ' + fp : 'clean'}`);
    for (const k of KINDS) {
      const r = readJson(recordPath(info, k), null);
      const fresh = r && fp && r.fingerprint === fp;
      console.log(`${k.padEnd(12)} ${r ? `${r.result} at ${r.time}${fresh ? ' (fresh)' : ' (stale: tree changed since)'}${r.note ? ' — ' + r.note : ''}` : 'never run'}`);
    }
    console.log(`gate         ${cfg.gate}, requires: ${(cfg.require || []).join(', ') || 'nothing'}`);
    console.log(`fast checks  ${detectFastChecks(info, cfg).map((c) => c.cmd).join(' | ') || 'none detected'}`);
    const w = fp && waiverFor(info, fp);
    if (w) console.log(`waiver       ${w.reason} (${w.time})`);
    console.log(`commit gate  ${gateVerdict(cfg, fp)}`);
  },

  checks() {
    needRepo();
    const cfg = loadConfig(info);
    const pol = diffPolicy(info);
    let ok = pol.problems.length === 0;
    for (const p of pol.problems) console.log(`✗ diff policy: ${p}`);
    for (const w of pol.warnings) console.log(`! diff policy: ${w}`);
    const results = runFastChecks(info, cfg, { only: args.length ? args : undefined });
    if (!results.length) console.log('(no fast checks detected — set "fastChecks" in verify.config.json)');
    for (const r of results) {
      console.log(`${r.ok ? '✓' : '✗'} ${r.name} (${(r.ms / 1000).toFixed(1)}s) ${r.cmd}${r.timedOut ? ' — TIMED OUT' : ''}`);
      if (!r.ok) {
        ok = false;
        console.log(r.output.replace(/^/gm, '    '));
      }
    }
    process.exit(ok ? 0 : 1);
  },

  record() {
    needRepo();
    const [kind, result, ...noteParts] = args;
    if (!KINDS.includes(kind) || !['pass', 'fail'].includes(result)) {
      console.error('usage: cv record <verify|review> <pass|fail> [note]');
      process.exit(2);
    }
    const fp = fingerprint(info);
    if (!fp) {
      console.error('cv: working tree is clean — nothing to record against. Record before committing.');
      process.exit(2);
    }
    writeJson(recordPath(info, kind), { result, fingerprint: fp, head: info.head, branch: info.branch, note: noteParts.join(' ') || undefined, time: new Date().toISOString() });
    console.log(`recorded ${kind}: ${result} for ${fp}. Commit gate: ${gateVerdict(loadConfig(info), fp)}`);
  },

  waive() {
    needRepo();
    const fp = fingerprint(info);
    if (!fp || !args.join(' ').trim()) {
      console.error('usage: cv waive <reason>   (needs uncommitted changes)');
      process.exit(2);
    }
    const reason = args.join(' ').trim();
    writeJson(waiverPath(info), { fingerprint: fp, reason, time: new Date().toISOString() });
    console.log(`verification waived for this exact tree (${fp}): ${reason}. Any further edit cancels the waiver.`);
  },

  notes() {
    needRepo();
    const f = resolveFile(info, 'verify.md', { ref: info.hasHead ? 'HEAD' : null });
    if (!f) return console.log('(no verify notes for this repo — run `cv init`)');
    console.log(`<!-- source: ${f.source} -->\n${f.content}`);
  },

  rules() {
    needRepo();
    const base = baseRef(info);
    const review = resolveFile(info, 'REVIEW.md', { ref: base?.tip });
    const checklist = path.join(KIT_DIR, 'checklist.md');
    console.log(`<!-- rules from: ${base ? base.ref + ' @ ' + base.tip.slice(0, 12) : 'none'} -->`);
    console.log(`<!-- REVIEW.md source: ${review ? review.source : 'none'} -->`);
    console.log(review ? review.content : '(no REVIEW.md for this repo)');
    if (fs.existsSync(checklist)) console.log(`\n<!-- reliability checklist: ${checklist} -->\n` + fs.readFileSync(checklist, 'utf8'));
  },

  diff() {
    needRepo();
    const base = baseRef(info);
    const stat = git(['diff', '--stat', ...(base ? [base.sha] : [])], info.root).out;
    const d = git(['diff', '--no-color', ...(base ? [base.sha] : [])], info.root).out;
    const untracked = git(['ls-files', '--others', '--exclude-standard'], info.root).out.trim();
    console.log(`# diff against ${base ? base.ref + ' (merge-base ' + base.sha.slice(0, 12) + ')' : 'nothing'}\n${stat}`);
    if (untracked) console.log(`# untracked (new) files — read them in full:\n${untracked}\n`);
    console.log(d);
  },

  'review-path'() {
    needRepo();
    const dir = ensureDir(path.join(info.stateDir, 'reviews', info.branch.replace(/[^\w.-]+/g, '_')));
    const prior = fs.readdirSync(dir).filter((f) => /^round-\d+\.md$/.test(f)).sort((a, b) => parseInt(a.slice(6)) - parseInt(b.slice(6)));
    console.log(`next: ${path.join(dir, `round-${prior.length + 1}.md`)}`);
    if (prior.length) console.log('earlier rounds (read them; re-check their open findings, don\'t redo everything):\n' + prior.map((p) => '  ' + path.join(dir, p)).join('\n'));
  },

  defer() {
    needRepo();
    const fp = fingerprint(info);
    if (!fp || !args.length) {
      console.error('usage: cv defer <reason>   (needs uncommitted changes)');
      process.exit(2);
    }
    const file = path.join(info.stateDir, 'stop.json');
    const s = readJson(file, {});
    s.deferred = { [fp]: { reason: args.join(' '), time: new Date().toISOString() } };
    writeJson(file, s);
    console.log(`fast checks deferred for this exact tree (${fp}). Any further edit re-enables them.`);
  },

  'accept-failing'() {
    needRepo();
    const [check, ...reason] = args;
    if (!check || !reason.length || !info.head) {
      console.error('usage: cv accept-failing <check-name> <reason>');
      process.exit(2);
    }
    const file = path.join(info.stateDir, 'stop.json');
    const s = readJson(file, {});
    s.acceptedFailing = { [info.head]: { ...((s.acceptedFailing || {})[info.head] || {}), [check]: reason.join(' ') } };
    writeJson(file, s);
    console.log(`'${check}' failures ignored by the Stop hook until HEAD moves from ${info.head.slice(0, 12)}.`);
  },

  init() {
    needRepo();
    const dir = ensureDir(privateRepoDir(info));
    for (const name of ['verify.md', 'REVIEW.md', 'verify.config.json']) {
      const dest = path.join(dir, name);
      const tpl = path.join(KIT_DIR, 'templates', name);
      if (!fs.existsSync(dest) && fs.existsSync(tpl)) {
        fs.copyFileSync(tpl, dest);
        console.log(`created ${dest}`);
      } else console.log(`exists  ${dest}`);
    }
    console.log('\nThese live outside the repo, so nothing is committed to the client\'s codebase.');
    console.log('If the team wants them shared, commit them as .claude/verify.md, REVIEW.md and .claude/verify.config.json instead.');
  },

  where() {
    needRepo();
    const base = baseRef(info);
    const show = (n, ref) => {
      const f = resolveFile(info, n, { ref });
      console.log(`${n.padEnd(20)} ${f ? f.source : '(none)'}`);
    };
    show('verify.config.json', info.hasHead ? 'HEAD' : null);
    show('verify.md', info.hasHead ? 'HEAD' : null);
    show('REVIEW.md', base?.tip);
    console.log(`${'checklist.md'.padEnd(20)} ${path.join(KIT_DIR, 'checklist.md')}`);
    console.log(`${'private folder'.padEnd(20)} ${privateRepoDir(info)}`);
    console.log(`${'state'.padEnd(20)} ${info.stateDir}`);
  },

  gate() {
    const file = path.join(KIT_DIR, 'config.json');
    const cfg = readJson(file, {});
    if (!args[0]) return console.log(`global gate mode: ${cfg.gate || 'observe'}${info ? `; effective here: ${loadConfig(info).gate}` : ''}`);
    if (!['off', 'observe', 'enforce'].includes(args[0])) {
      console.error('usage: cv gate [off|observe|enforce]');
      process.exit(2);
    }
    cfg.gate = args[0];
    writeJson(file, cfg);
    console.log(`global gate mode set to ${args[0]}`);
  },

  report() {
    needRepo();
    const n = parseInt(args[0] || '30', 10);
    const { bySha, byTree } = readLedger(info);
    // %(trailers) is only a fallback for commits stamped by older versions of the kit.
    const r = git(['log', `-n${n}`, '--format=%H%x1f%T%x1f%an%x1f%s%x1f%(trailers:key=Verified-By,valueonly,separator=%x2C )%x1e'], info.root).out;
    const rows = r.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => s.split('\x1f'));
    const tally = { verified: 0, waived: 0, unverified: 0, unrecorded: 0 };
    for (const [sha, tree, author, subj, stamp] of rows) {
      const e = bySha.get(sha) || byTree.get(tree);
      let label;
      let kind;
      if (e) {
        label = describeEntry(e);
        kind = entryKind(e);
      } else if (stamp) {
        label = 'stamp: ' + stamp;
        kind = /^none/i.test(stamp) ? 'waived' : 'verified';
      } else {
        label = '—';
        kind = 'unrecorded';
      }
      tally[kind]++;
      console.log(`${sha.slice(0, 7)}  ${label.padEnd(28).slice(0, 28)}  ${author.slice(0, 14).padEnd(14)}  ${subj.slice(0, 70)}`);
    }
    console.log(
      `\n${rows.length} commits: ${tally.verified} verified, ${tally.waived} waived, ${tally.unverified} unverified, ` +
        `${tally.unrecorded} unrecorded (not made through Claude, or made before the ledger existed)`,
    );
  },

  log() {
    const n = parseInt(args[0] || '20', 10);
    if (!fs.existsSync(GATE_LOG)) return console.log('(no gate decisions yet)');
    const lines = fs.readFileSync(GATE_LOG, 'utf8').trim().split('\n').slice(-n);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        console.log(`${e.time}  ${e.decision.padEnd(11)} ${e.mode.padEnd(8)} ${e.repo}@${e.branch}${e.problem ? '\n    ' + e.problem : ''}`);
      } catch {
        /* skip */
      }
    }
  },

  fingerprint() {
    needRepo();
    console.log(fingerprint(info) || 'clean');
  },
};

(commands[cmd] || commands.help)();

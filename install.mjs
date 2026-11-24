#!/usr/bin/env node
// Installs the Claude verification kit into ~/.claude (user level, works in every repo).
//   node install.mjs              install or update (also adds the `cv` command to your shell)
//   node install.mjs --dry-run    show what would change
//   node install.mjs --no-alias   install without touching your shell config
//   node install.mjs --uninstall  remove hooks, skills, CLAUDE.md block and the `cv` alias
//                                 (keeps your notes in ~/.claude/verification/repos)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE = path.join(os.homedir(), '.claude');
const KIT = path.join(CLAUDE, 'verification');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE, 'CLAUDE.md');
const DRY = process.argv.includes('--dry-run');
const UNINSTALL = process.argv.includes('--uninstall');
const NO_ALIAS = process.argv.includes('--no-alias');
const CV_PATH = path.join(KIT, 'bin', 'cv.mjs');
const ALIAS_START = '# >>> claude-verify-kit >>>';
const ALIAS_END = '# <<< claude-verify-kit <<<';
const START = '<!-- claude-verify-kit:start -->';
const END = '<!-- claude-verify-kit:end -->';

const log = (...a) => console.log((DRY ? '[dry-run] ' : '') + a.join(' '));
const q = (p) => `"${p.replace(/\\/g, '/')}"`;
const STOP_CMD = `node ${q(path.join(KIT, 'bin', 'stop-checks.mjs'))}`;
const GATE_CMD = `node ${q(path.join(KIT, 'bin', 'commit-gate.mjs'))}`;
const POST_CMD = `node ${q(path.join(KIT, 'bin', 'post-commit.mjs'))}`;

// Files the user is expected to edit: never overwritten on update.
const USER_OWNED = new Set(['checklist.md', 'config.json']);

function copyTree(from, to, rel = '') {
  for (const entry of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
    const r = path.join(rel, entry.name);
    const s = path.join(from, r);
    const d = path.join(to, r);
    if (entry.isDirectory()) {
      if (!DRY) fs.mkdirSync(d, { recursive: true });
      copyTree(from, to, r);
    } else {
      if (USER_OWNED.has(r) && fs.existsSync(d)) {
        log('keep   ', d, '(yours)');
        continue;
      }
      const same = fs.existsSync(d) && fs.readFileSync(d).equals(fs.readFileSync(s));
      if (same) continue;
      log(fs.existsSync(d) ? 'update ' : 'create ', d);
      if (!DRY) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
      }
    }
  }
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (e) {
    console.error(`Can't parse ${SETTINGS} (${e.message}). Fix it or add the hooks by hand (see README).`);
    process.exit(1);
  }
}

function writeSettings(s) {
  if (DRY) return log('write  ', SETTINGS);
  if (fs.existsSync(SETTINGS)) {
    const bak = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(SETTINGS, bak);
    log('backup ', bak);
  }
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
  log('write  ', SETTINGS);
}

const isOurs = (h) => /verification[\\/]bin[\\/](?:stop-checks|commit-gate|post-commit)\.mjs/.test(h?.command || '');

function stripOurHooks(s) {
  for (const ev of ['Stop', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    if (!Array.isArray(s.hooks?.[ev])) continue;
    s.hooks[ev] = s.hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

function updateClaudeMd(add) {
  let md = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
  const re = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`);
  const snippet = fs.readFileSync(path.join(SRC, 'CLAUDE.snippet.md'), 'utf8');
  const old = md.match(re)?.[0].trim() ?? null;
  const had = old != null;
  if (add && old === snippet.trim()) return; // already up to date
  if (!add && !had) return;
  md = md.replace(re, '\n');
  if (add) md = md.trimEnd() + (md.trim() ? '\n\n' : '') + snippet;
  // The block between the markers belongs to the kit and is replaced as a whole, so keep a copy
  // in case it was edited by hand.
  if (had) {
    const bak = `${CLAUDE_MD}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (!DRY) fs.copyFileSync(CLAUDE_MD, bak);
    log('backup ', bak);
    console.log(
      `  note: the kit's block in ${CLAUDE_MD} is replaced on every update/uninstall. If you edited it, ` +
        `your version is in the backup; keep personal rules outside the claude-verify-kit markers.`,
    );
  }
  log(add ? (had ? 'update ' : 'append ') : 'remove ', `${CLAUDE_MD} (verification block)`);
  if (!DRY) fs.writeFileSync(CLAUDE_MD, md.trimEnd() + '\n');
}

// The shell startup file the `cv` alias goes in (zsh/bash only; others get printed instructions).
function shellRc() {
  const shell = path.basename(process.env.SHELL || '');
  if (process.platform === 'win32') return null;
  if (shell === 'zsh') return path.join(os.homedir(), '.zshrc');
  if (shell === 'bash') return path.join(os.homedir(), process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
  return null;
}

// Returns the rc file it changed, or null.
function updateAlias(add) {
  const rc = shellRc();
  if (!rc) return null;
  let text = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
  const re = new RegExp(`\\n?${ALIAS_START}[\\s\\S]*?${ALIAS_END}\\n?`);
  const had = re.test(text);
  text = text.replace(re, '\n');
  if (add) text = text.trimEnd() + `\n\n${ALIAS_START}\nalias cv='node "${CV_PATH}"'\n${ALIAS_END}\n`;
  else if (!had) return null;
  log(add ? (had ? 'update ' : 'append ') : 'remove ', `${rc} (cv alias)`);
  if (!DRY) fs.writeFileSync(rc, text.trimEnd() + '\n');
  return rc;
}

if (UNINSTALL) {
  writeSettings(stripOurHooks(readSettings()));
  for (const sk of ['verify', 'review-changes']) {
    const d = path.join(CLAUDE, 'skills', sk);
    if (fs.existsSync(path.join(d, 'SKILL.md')) && /claude\/verification\/bin\/cv\.mjs/.test(fs.readFileSync(path.join(d, 'SKILL.md'), 'utf8'))) {
      log('remove ', d);
      if (!DRY) fs.rmSync(d, { recursive: true, force: true });
    }
  }
  for (const sub of ['bin', 'templates', 'defaults']) {
    const d = path.join(KIT, sub);
    if (fs.existsSync(d)) {
      log('remove ', d);
      if (!DRY) fs.rmSync(d, { recursive: true, force: true });
    }
  }
  updateClaudeMd(false);
  if (!NO_ALIAS) updateAlias(false);
  console.log(`\nUninstalled. Kept your notes, checklist, config and gate log in ${KIT}.`);
  process.exit(0);
}

// --- install / update ---
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(`Node ${process.versions.node} is too old; the kit needs Node 18+.`);
  process.exit(1);
}

copyTree(path.join(SRC, 'verification'), KIT);
for (const sk of ['verify', 'review-changes']) copyTree(path.join(SRC, 'skills', sk), path.join(CLAUDE, 'skills', sk));

const cfgFile = path.join(KIT, 'config.json');
if (!fs.existsSync(cfgFile)) {
  log('create ', cfgFile);
  if (!DRY) fs.writeFileSync(cfgFile, JSON.stringify({ gate: 'observe', require: ['verify'] }, null, 2) + '\n');
}

const s = stripOurHooks(readSettings());
s.hooks ||= {};
(s.hooks.Stop ||= []).push({ hooks: [{ type: 'command', command: STOP_CMD, timeout: 600 }] });
(s.hooks.PreToolUse ||= []).push({ matcher: 'Bash', hooks: [{ type: 'command', command: GATE_CMD, timeout: 30 }] });
// After the commit, success or failure (the commit can exist even if a later `&& git push` fails).
for (const ev of ['PostToolUse', 'PostToolUseFailure'])
  (s.hooks[ev] ||= []).push({ matcher: 'Bash', hooks: [{ type: 'command', command: POST_CMD, timeout: 30 }] });
writeSettings(s);
updateClaudeMd(true);
const rc = NO_ALIAS ? null : updateAlias(true);

console.log(`
✔ Installed.
  Skills:  /verify and /review-changes   (in ${path.join(CLAUDE, 'skills')})
  Hooks:   Stop → fast checks; before git commit → commit gate (mode: observe); after → commit ledger
  Command: cv  →  node ${CV_PATH}

Next steps:
  1. ${rc ? `Load the new cv command:   source ${rc.replace(os.homedir(), '~')}     (or open a new terminal)` : `Add the cv command yourself:   alias cv='node "${CV_PATH}"'`}
  2. Restart Claude Code (close open sessions) so it picks up the hooks and skills.
  3. In each project, from inside the repo folder:   cd <your-project> && cv init
  4. In Claude Code in that project, ask: "Fill in my verify notes for this repo: how to boot it,
     and a feature map of the main user flows."
  5. Daily: work as usual, /verify before committing, /review-changes before a PR.

Full guide: README.md`);

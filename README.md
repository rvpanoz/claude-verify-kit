# claude-verify-kit

A portable verification setup for Claude Code. It installs once into `~/.claude` and works in every repo you open, so it moves with you between projects and nothing gets committed to their codebases.

| Piece | What it does |
|---|---|
| `/verify` skill | Cheap checks first, then **runs the change**: boots the app and drives the affected flows (Playwright/browser for web, `curl` for APIs, scripts or property tests for logic, old-vs-new diffs for refactors). At most 3 fix rounds, then it hands over to you. Records the result. |
| `/review-changes` skill | Reviews the branch against `REVIEW.md` **read from the default branch** (a change can't rewrite its own rules) plus your reliability checklist. Applies only the items whose trigger matches the diff, tags findings Important / Nit / Pre-existing, and builds on earlier rounds. |
| Stop hook | When Claude finishes a turn with uncommitted changes, it runs lint, typecheck and unit tests, and blocks `.only`/`.skip`/retries/sleeps added to tests. On failure Claude goes back to fix it, up to 3 rounds, then the failure is handed to you. |
| Commit gate | Before Claude commits, a passing verify record (or an explicit `cv waive "<reason>"`) must exist for that exact working tree. Nothing is added to the commit message: the outcome goes to a local commit ledger. Modes: `off` / `observe` / `enforce`. After 2 blocks in a session the next commit goes through, so Claude never gets stuck. |
| `cv` CLI | Status, records, waivers, reports on how commits were verified, and the gate log. |

Requires Node 18+ and git. No dependencies.

## Setup, step by step

Each step says **where** to run it.

### Once, on your machine

**1. Install.** Run this in a terminal:
```bash
git clone https://github.com/rvpanoz/claude-verify-kit.git
cd claude-verify-kit
node install.mjs --dry-run   # optional: preview what will change
node install.mjs
```
This adds the two skills to `~/.claude/skills/`, the scripts to `~/.claude/verification/`, hooks to `~/.claude/settings.json` (Stop, plus before and after Bash commands) (your existing hooks are kept, and the file is backed up first), and a short block to `~/.claude/CLAUDE.md`. It also adds the `cv` command to your shell (`~/.zshrc` for zsh, `~/.bashrc` or `~/.bash_profile` for bash). Use `--no-alias` to skip that.

**2. Load the `cv` command.** Run this anywhere, or just open a new terminal:
```bash
source ~/.zshrc
cv help        # should print the command list
```
If you use another shell, add it yourself: `alias cv='node ~/.claude/verification/bin/cv.mjs'`.

**3. Restart Claude Code.** Close any open sessions so they pick up the hooks and skills.

### Once per project

**4. Initialise the repo.** Run this **inside the project folder**, on any branch:
```bash
cd ~/code/my-project    # your project
cv init        # creates private notes, rules and config for this repo
cv where       # which files are in effect
cv status      # which lint / typecheck / test commands were detected
```
`cv init` writes `verify.md`, `REVIEW.md` and `verify.config.json` to `~/.claude/verification/repos/<repo>/`, outside the repo, so nothing is committed to the project's code. The folder is tied to the repo's remote URL, so all branches share it. If the repo already has a committed `REVIEW.md` or `.claude/verify.md`, those take priority automatically.

**5. Fill in the verify notes.** Start `claude` in the project and ask:
> Fill in my verify notes for this repo: how to boot it, and a feature map of the main user flows.

You can skip this step: `/verify` does it the first time if the notes are empty.

### Every day, in Claude Code

**6.** Work as usual. The Stop hook runs the cheap checks whenever Claude finishes with uncommitted changes.

**7.** Before committing, run `/verify`. Claude runs the change end to end and reports the evidence.

**8.** Before a PR, or for anything risky, run `/review-changes`.

**9.** Ask Claude to commit. The gate checks the verify record; `cv status` shows whether the next commit would go through. For changes where verification doesn't apply (docs, comments), Claude runs `cv waive "<reason>"` first.

### About once a week, in a terminal inside a project

**10.** Check how things are going:
```bash
cv report 50   # how your recent commits were verified (from the commit ledger)
cv log         # what the gate blocked, or would have blocked
```
When a bug slips through, ask Claude to turn it into a checklist item (Trigger / Check / Why). Delete items that never fire.

**11.** After about a week of clean logs, turn on enforcement (see below).

### Uninstall

```bash
node install.mjs --uninstall   # removes hooks, skills, CLAUDE.md block and the cv alias; keeps your notes and logs
```

## Rolling out the gate (observe → enforce)

The gate starts in **observe**: nothing is blocked, and every decision goes to `~/.claude/verification/gate.log`. After a week or so, check `cv log` for false positives, then:

```bash
cv gate enforce          # globally
```
or per repo in its `verify.config.json`: `"gate": "enforce"`, and `"require": ["verify", "review"]` if you want review mandatory too.

## Where things live

```
~/.claude/skills/verify/SKILL.md, review-changes/SKILL.md
~/.claude/verification/
  bin/            cv.mjs, stop-checks.mjs, commit-gate.mjs, post-commit.mjs, lib.mjs
  checklist.md    your personal reliability checklist (yours: never overwritten on update)
  config.json     global settings, e.g. {"gate":"observe","require":["verify"]}
  repos/<repo>/   private per-repo verify.md, REVIEW.md, verify.config.json
  templates/, defaults/
  gate.log        every gate decision
<repo>/.git/claude-verify/   records, waivers, Stop-hook state, review rounds and commits.jsonl,
                             the ledger of how each Claude commit was verified (inside .git, never committed)
```

How each file is looked up: committed in the repo (config and notes from `HEAD`, `REVIEW.md` from the default branch tip, never from your working copy), then your private folder, then the kit default. `cv where` shows which one is in effect.

## Config keys (`verify.config.json` or `~/.claude/verification/config.json`)

| Key | Default | |
|---|---|---|
| `gate` | `observe` | `off`, `observe` or `enforce`. Env override: `CLAUDE_VERIFY_GATE` |
| `require` | `["verify"]` | Records needed before the gate allows a commit |
| `stopHook` | `true` | Env override: `CLAUDE_VERIFY_STOP=off` |
| `fastChecks` | auto | e.g. `[{"name":"test","cmd":"pnpm vitest run --changed"}]` for a big suite |
| `maxStopRounds` / `maxGateBlocks` | 3 / 2 | |
| `checkTimeoutSec` | 240 | Per check |

Auto-detection uses the `lint`, `typecheck`/`type-check`/`tsc` and `test:unit`/`test` scripts from `package.json` with your lockfile's package manager, and runs them with `CI=true` so Vitest and Jest don't start in watch mode.

## Escape hatches (Claude is told to tell you when it uses them)

- `cv defer "<reason>"`: stop without passing the checks, for this exact tree only (e.g. Claude needs to ask you something mid-task).
- `cv accept-failing <check> "<reason>"`: a check that already fails on `HEAD` is ignored until `HEAD` moves.
- `// verify-allow: <reason>` on a line: exempts it from the diff policy.
- `cv waive "<reason>"`: an explicit opt-out for this exact tree. It shows up as `waived: <reason>` in `cv report`.

## Limits, honestly

- **It runs on trust.** `cv record verify pass` is a command Claude runs at the end of `/verify`. The gate proves the record matches the exact tree being committed and that nothing changed afterwards, not that the verification was thorough. Spot-check the evidence Claude reports.
- Only commits made **through Claude Code** are gated. Your own terminal commits are untouched (they show as "unrecorded" in `cv report`).
- If your full test suite is slow, set `fastChecks` so the Stop hook stays fast, and keep heavy E2E runs for `/verify`.
- The ledger is local to your clone and keyed by commit SHA, with the tree as a fallback. Commits rewritten by a rebase that changes their content show as "unrecorded".

## Credits

Inspired by [Addy Osmani's post](https://x.com/addyosmani/status/2122590683055993308).

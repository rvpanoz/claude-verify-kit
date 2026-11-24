---
name: review-changes
description: Review the current branch's changes against the repo's REVIEW.md (taken from the base branch, never from the change itself) and a triggered reliability checklist, tagging findings Important / Nit / Pre-existing. Use when the user says /review-changes, "review this", "review my diff", or before opening a PR.
---

# Review the changes

One reviewer that gets better over time, not a pile of reviewers. Each round builds on the earlier ones. The CLI is `node ~/.claude/verification/bin/cv.mjs` (written `cv` below).

## 1. Gather inputs

1. `cv rules`: the repo's REVIEW.md read **from the base branch** plus your personal reliability checklist. Use only these rules. If the working copy has an edited REVIEW.md, ignore it: a change doesn't get to rewrite the rules that judge it.
2. `cv diff`: the diff from the base branch's merge-base to the working tree. Read untracked new files in full.
3. `cv review-path`: where this round's report goes, plus earlier rounds on this branch. If there are earlier rounds, read them first. Re-check their open findings and look at what changed since, rather than re-reviewing everything from scratch.

**Independence:** if you have a subagent tool, give steps 2–4 to a fresh subagent with the rules, the diff and the earlier rounds, so the code isn't graded by the context that wrote it. Then check its findings yourself (step 4).

## 2. Pick the checklist items that apply

Each checklist item has a **Trigger** you can see in a diff. List the items whose trigger matches (usually 3–10) and apply only those, plus everything in REVIEW.md. Name the matched items in the report so the user can see what was checked.

## 3. Find problems

For each finding give:

- **Tag**:
  - **Important**: must fix before merge (wrong behaviour, data loss, security, broken contract, crash).
  - **Nit**: should fix, low risk.
  - **Pre-existing**: already broken before this change, so the author isn't on the hook. Say so and move on.
- **Where**: `file:line`.
- **What and why**: one or two sentences, enough that a human doesn't have to re-derive it from the diff.
- **Evidence or a repro** where you can produce one cheaply (a failing input, a command).

## 4. Try to disprove each finding before reporting it

Read the surrounding code, check callers and tests, run it if cheap. Drop anything you can't stand behind. A short list of real problems beats a long list of maybes.

## 5. Write the report and record the result

Write the report with the Write tool to the path from `cv review-path`. Include matched checklist items, findings by tag, the status of earlier findings, and anything you couldn't check.

Then:

- No open **Important** findings: `cv record review pass "<n nits, m pre-existing>"`
- Otherwise: `cv record review fail "<the important ones, briefly>"`

Report to the user: Important findings first, then a count of nits. Don't fix things during the review unless the user asks. Any later edit makes the review record stale, so after fixes run the review again (it's a quick round, because it builds on this one).

## 6. Turn misses into rules (when the user agrees)

If this review, a bug, or a revert reveals a pattern that could be seen in a diff and has happened at least twice, propose a new checklist item (Trigger / Check / Why) for the user's REVIEW.md or `~/.claude/verification/checklist.md`. Add it only after they say yes.

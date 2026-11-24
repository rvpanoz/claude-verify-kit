---
name: verify
description: Verify the current uncommitted change by actually running it — fast checks, then driving the real app end to end (browser, API, CLI) and collecting evidence. Use before every commit, when the user says /verify, "test it", "make sure it works", or before opening a PR.
---

# Verify the change by running it

Passing unit tests is not verification. Verification means running the changed behaviour the way a user or QA engineer would and collecting evidence that it works. Work through the steps in order, and keep going until you have evidence or hit the round limit.

The kit's CLI is `node ~/.claude/verification/bin/cv.mjs` (written `cv` below).

## 1. Orient (keep it short)

- `cv status`: what changed, existing records, which fast checks were detected.
- `cv notes`: this repo's verify notes (how to boot the app, ports, test accounts, feature map). They are read from HEAD or from the user's private folder, never from your uncommitted changes.
  - If there are none, run `cv init` once, then work out how to boot and drive the app from `package.json` scripts, README, docker-compose, `.env.example` and the Playwright/Cypress config. Write what you learned into the private `verify.md` that `cv where` points to, so the next run is fast. Tell the user you did this.
- `git diff HEAD --stat` plus a read of the diff: which user-visible behaviour changed? List the 1–5 flows that prove it, taken from the feature map where possible.

## 2. Cheap checks first

`cv checks` runs the diff policy (no `.only`, `.skip`, retries, or sleeps added to tests), lint, typecheck and unit tests. Fix failures before going further. Heavier checks are wasted on a change that doesn't compile.

## 3. Run the change end to end

Pick whichever fits the change:

- **Web UI (React etc.)**: start the dev server in the background (the notes say how, e.g. `pnpm dev`), wait for the port, then drive the affected flows.
  - Prefer the repo's Playwright setup: write or extend an E2E spec for the flow and run only that spec (`npx playwright test path/to/spec --reporter=line`).
  - With no Playwright in the repo, use a browser tool if one is available (Claude in Chrome, a browser MCP). Failing that, use a throwaway script under `/tmp` with `npx --yes playwright` and never add it to the repo's dependencies without asking.
  - Take screenshots of the end state of each flow, check the browser console for errors, and check failed network requests.
- **API / Node service**: start it locally (with its DB/containers if the notes say so). Hit the changed endpoints with `curl -sS -i` covering the happy path, a validation error and an auth failure, and check status codes, bodies and the server log (no stack traces, no secrets or PII in logs).
- **Library / CLI / pure logic**: run a short script against the public API. When the logic has an invariant (round-trip encode/decode, idempotent, never negative, optimized equals naive), add a property test with `fast-check` if the repo has it or will accept it.
- **Refactor or migration that must not change behaviour**: do a differential check. Run the base version (`git worktree add /tmp/base <base-sha>`) and the new version on the same inputs, normalise irrelevant noise, and diff the outputs.

Stop any servers you started when you're done.

## 4. Fix loop: at most 3 rounds

If something fails, find the root cause, fix it, and re-run from step 2. **After 3 failed rounds, stop.** Record a fail (step 5) and hand it to the user with the evidence: what you ran, what happened, and your best hypothesis.

Never make it pass by skipping or deleting a test, adding sleeps or retries, loosening assertions, or updating snapshots you haven't looked at. If a test is flaky and you can't find the cause, say so and leave it for the user. These are often client repos, so don't delete tests without asking.

## 5. Record the result and report

- On success: `cv record verify pass "<one line: what you ran, e.g. 'playwright checkout.spec + manual cart flow, curl /orders 201/400/401'>"`
- On failure: `cv record verify fail "<what's still broken>"`

Any edit after recording makes the record stale, so record last.

Report to the user in a few lines: the flows you checked, the commands you ran, pass/fail, and where any screenshots are. Don't paste long logs.

## 6. When committing

End the commit message with the stamp trailer that `cv status` prints:

```
Verified-By: verify            # or "verify, review" if /review-changes also passed
Verified-By: none - <reason>   # only when verification genuinely doesn't apply (docs, comments)
```

The commit gate checks that the stamp matches a passing record for the exact tree being committed.

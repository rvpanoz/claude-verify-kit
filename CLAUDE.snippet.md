<!-- claude-verify-kit:start -->
## Verification (claude-verify-kit)

- Before committing a change, run the `verify` skill: fast checks, then run the changed behaviour end to end and collect evidence. For non-trivial changes or before a PR, also run `review-changes`.
- Cheap checks first: lint, typecheck and unit tests pass locally before any push or PR.
- End every commit message with the stamp `cv status` prints: `Verified-By: verify[, review]`, or `Verified-By: none - <reason>` when verification genuinely doesn't apply.
- Never make checks pass by skipping or deleting tests, adding `.only`/`.skip`, sleeps or retries, loosening assertions, or blindly updating snapshots. If a test is flaky and the cause isn't clear, tell me instead.
- If something still fails after 3 fix rounds, stop and hand it to me with the evidence.
- Don't commit kit files (`.claude/verify.md`, `REVIEW.md`) into a repo unless I ask. Per-repo notes live in `~/.claude/verification/repos/`.
- CLI: `node ~/.claude/verification/bin/cv.mjs help`
<!-- claude-verify-kit:end -->

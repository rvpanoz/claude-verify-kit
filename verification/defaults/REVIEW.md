# Default review focus (no REVIEW.md in this repo)

- Correctness of the changed behaviour, including edge cases and error paths
- Matches the conventions already used in the surrounding code (don't introduce a second way of doing something)
- Security: authentication and authorization, input validation, secrets, injection
- Backwards compatibility of stored data, APIs and public interfaces
- Tests cover the change and weren't weakened to pass
- Don't flag formatting or style the linter already enforces

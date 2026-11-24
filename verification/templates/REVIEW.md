# REVIEW.md: <project name>

What the reviewer should pay attention to in this codebase. `/review-changes` reads this file from the **base branch**, so edits made on a feature branch don't apply to that branch's own review.

## Always check

- e.g. All API handlers validate input with the shared zod schemas in `src/schemas/`
- e.g. Money is integer cents end to end, never floats
- e.g. Any new page under `app/(authed)/` must go through `requireSession()`

## Ignore / don't flag

- e.g. Generated files: `src/gen/**`, `*.snap`
- e.g. Style issues the linter already enforces

## Project-specific checklist

Same format as the global checklist: each item needs a trigger you can see in a diff.

### Changing the order status enum
- **Trigger:** diff touches `OrderStatus` or `order_status` migrations
- **Check:** the mobile app (older versions still live) handles unknown statuses
- **Why:** incident or PR link

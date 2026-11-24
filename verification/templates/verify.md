# Verify notes: <project name>

How Claude boots, drives and inspects this app. `/verify` reads this first. Keep it short and correct; Claude can update it when something here is wrong.

## Boot

- Install: `pnpm install`
- Services: `docker compose up -d db redis` (wait for `pg_isready`)
- App: `pnpm dev` → http://localhost:3000 (ready when the log shows "ready")
- API: `pnpm --filter api dev` → http://localhost:4000/health returns 200
- Env: copy `.env.example` to `.env.local`. Test credentials are in env vars `E2E_USER` / `E2E_PASSWORD` (never paste real ones here)

## E2E

- Runner: `npx playwright test <spec> --reporter=line` (config: `playwright.config.ts`)
- Specs live in: `e2e/`
- Logs to check: browser console errors, failed network requests, API server stdout

## Feature map

What a user can do, written from their point of view. Used as the guide and grading rubric.

| Flow | Path / entry | Steps & selectors | Expected result |
|---|---|---|---|
| Sign in | `/login` | fill `[name=email]`, `[name=password]`, click `button[type=submit]` | lands on `/dashboard`, avatar visible |
| Add to cart | `/products/:id` | click `[data-testid=add-to-cart]` | cart badge increments, toast "Added" |
| Checkout | `/cart` → `/checkout` | … | `/orders/:id/confirmation`, order in DB |

## Gotchas

- e.g. "first load compiles for ~20s, wait for the network to go idle"
- e.g. "Stripe is in test mode, use card 4242…"

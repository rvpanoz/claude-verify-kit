# Reliability checklist (personal, all repos)

`/review-changes` applies only the items whose **Trigger** matches the diff. Each item: Trigger (visible in a diff) → Check → Why.
Replace the "Why" with your own incidents and PRs over time, and delete items that never catch anything. A short list that fires is better than a long one that doesn't.

### 1. New field on persisted or serialized data
- **Trigger:** a field added or renamed on a type that is stored or sent: DB model, localStorage/sessionStorage, cache entry, API response/request, queue message, cookie
- **Check:** old data without the field still loads (default/optional handling); old clients still accept the new shape
- **Why:** data written before the deploy outlives the deploy (same idea as Claude Code's "--resume loads old transcripts")

### 2. Database migration
- **Trigger:** files in `migrations/`, `prisma/schema.prisma`, `*.sql`, ORM model changes
- **Check:** reversible or has a down path; safe on a large table (no long locks, backfill in batches); deployable before the code that uses it; NOT NULL columns have defaults
- **Why:** migrations run against production data and are the hardest thing to roll back

### 3. API contract change
- **Trigger:** route path/method/status code/response shape changes, removed or renamed fields, changed validation
- **Check:** existing consumers (frontend, mobile, other services) still work; versioning or a compatibility shim where needed; OpenAPI/types updated
- **Why:** the other side of the contract deploys on its own schedule

### 4. Auth and authorization
- **Trigger:** new route/handler/server action/page, middleware changes, anything reading `user`, `session`, `role`, `tenant`
- **Check:** authentication is required where it should be; authorization checks the resource belongs to the caller (no IDOR); multi-tenant queries are scoped by tenant
- **Why:** a missing check is invisible in the happy path

### 5. Logging and errors
- **Trigger:** new `console.*`, logger calls, error messages, Sentry/telemetry calls
- **Check:** no tokens, passwords, emails, addresses or full request bodies logged; errors returned to clients don't leak stack traces or SQL
- **Why:** logs are copied everywhere and kept for a long time

### 6. Environment and config
- **Trigger:** new `process.env.*` / `import.meta.env.*`, config file changes
- **Check:** validated at startup with a clear error; added to `.env.example`/docs; secrets never shipped to the client bundle (`NEXT_PUBLIC_`/`VITE_` prefixes)
- **Why:** it works locally and crashes or leaks in another environment

### 7. React effects and subscriptions
- **Trigger:** `useEffect`/`useLayoutEffect` added or changed; event listeners, intervals, websockets, observers
- **Check:** complete dependency array (no stale closures); cleanup removes listeners and timers; fetches use `AbortController` or ignore late results; no state updates after unmount; no infinite render loop
- **Why:** leaks and races only show up after navigation or under slow networks

### 8. Data fetching and async flow
- **Trigger:** new `fetch`/axios/query hooks, `Promise.all`, async work in loops, retries
- **Check:** errors handled and shown; loading and empty states; timeouts; no unbounded parallelism; no unhandled rejections; retries are idempotent
- **Why:** the happy path is all a quick manual check covers

### 9. Lists, keys and pagination
- **Trigger:** `.map(` rendering JSX, list endpoints, `limit`/`offset`/cursor code
- **Check:** stable, unique `key` (not the index for reorderable lists); pagination has no off-by-one; large lists are bounded or virtualized; server-side limits enforced
- **Why:** this works with 3 test rows and breaks with 3,000

### 10. Dates, money and numbers
- **Trigger:** `Date`, date libraries, timezone/locale formatting, currency, arithmetic on prices or quantities
- **Check:** stored in UTC; DST and month-end edges; money as integer minor units or decimal, never float sums; rounding rules explicit
- **Why:** these bugs pass tests written in one timezone

### 11. Input handling and injection
- **Trigger:** string-built SQL/queries, `dangerouslySetInnerHTML`, `eval`/`new Function`, shelling out, file paths from user input, redirects to user-supplied URLs
- **Check:** parameterized queries; sanitized HTML; no path traversal; allow-listed redirects
- **Why:** classic, still common, and easy to miss in a big diff

### 12. Dependencies
- **Trigger:** `package.json` dependency added, removed or bumped
- **Check:** lockfile updated in the same change; major-version changelog read for breaking changes; licence acceptable for the client; not pulled into the client bundle by accident; no near-duplicate of an existing dependency
- **Why:** dependency changes are small diffs with large effects

### 13. Tests weakened alongside the code
- **Trigger:** test files changed in the same diff as the code they test; snapshot files updated
- **Check:** assertions weren't loosened to make the change pass; snapshot diffs are intended; removed tests are explained
- **Why:** the easiest way to make a failing test pass is to change the test

### 14. Caching and state invalidation
- **Trigger:** cache keys, `revalidate`, React Query/SWR keys, memoization, CDN headers
- **Check:** every write path invalidates or updates what it should; cache keys include everything the result depends on (user, tenant, locale)
- **Why:** stale or cross-user data shows up only in production traffic

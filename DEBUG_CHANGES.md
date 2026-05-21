# Debug / Temporary Changes

Changes that must be reverted or hardened before merging to main.

---

## 1. Unauthenticated debug routes (`/admin/debug/*`)

**Files:**
- `backend/src/routes/admin/debug.ts` — delete this file entirely
- `backend/src/routes/admin/index.ts` — remove the `debugRouter` import and `router.use('/debug', debugRouter)` line

**Why it exists:** SSO via Authentik is not wired up yet, so `requireAdmin` can't be used. Routes are localhost-only as a minimal safety measure.

**Fix:** Once SSO login works, delete `debug.ts` and the two lines in `index.ts`.

---

## 2. Local docker-compose files without Traefik

**Files:**
- `docker-compose.local.yml` — delete this file
- `docker-compose.local.dev.yml` — delete this file

**Why they exist:** Production compose requires an external `traefik_proxy` network which doesn't exist in a local dev environment. These files are standalone alternatives that expose ports directly.

**Fix:** Delete both files once the production Traefik setup is available locally, or promote this pattern into the standard dev flow.

---

## 3. `SKIP_OIDC=true` — bypass Authentik discovery at startup

**Files:**
- `backend/src/server.ts` — remove the `SKIP_OIDC` branch, restore the OIDC env var requirement and `setupPassport` call as unconditional

**Why it exists:** Authentik isn't reachable in the local Samba4 test environment, so `Issuer.discover()` hangs/errors at boot.

**Fix:** Remove the `if (SKIP_OIDC)` block once Authentik is available. Also remove `SKIP_OIDC=true` from `.env`.

---

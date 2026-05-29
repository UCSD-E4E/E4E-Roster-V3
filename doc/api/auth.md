# Auth Routes

All routes are public (no auth required) unless noted.

---

## GET /login
Renders the SSO login page.

| Condition | Output |
|---|---|
| Already authenticated | `302 → /` |
| `?error=1` in query | Renders login page with error banner |
| Default | Renders login page |

---

## GET /auth/login
Initiates the OIDC authorization code flow. Stores `state`, `code_verifier` (PKCE) in the session and redirects the browser to Authentik.

| Condition | Output |
|---|---|
| Session missing | `TypeError: authentication requires session support` → 500 |
| Default | `302 → Authentik authorization endpoint` |

---

## GET /auth/callback
Authentik redirects here after the user authenticates. Validates the OIDC response, exchanges the code for tokens, fetches userinfo, runs the verify callback (builds org memberships, upserts `user_orgs`), then regenerates the session to prevent session fixation.

| Condition | Output |
|---|---|
| OIDC state missing from session | `302 → /login?error=1` |
| Token exchange / ID token validation fails | `302 → /login?error=1` |
| Userinfo fetch fails | `302 → /login?error=1` |
| Verify callback throws (DB error, etc.) | `500` via error handler |
| Session regeneration fails | `500` via error handler |
| `req.login` fails | `500` via error handler |
| Success | `302 → /` (root redirect applies role-based logic) |

**Post-login root redirect logic (`/`):**

| User type | Has orgs? | Destination |
|---|---|---|
| System admin / local admin | Yes | `/orgs` |
| System admin / local admin | No | `/system` |
| Regular user | Exactly 1 org | `/orgs/:orgSlug/dashboard` |
| Regular user | Multiple orgs | `/orgs` |
| Regular user | No orgs | `/orgs` (empty selector) |

---

## POST /logout
Logs out via passport, destroys the session.

| Condition | Output |
|---|---|
| Logout error | `500` via error handler |
| Success | `302 → /login` |

---

## GET /local-login
Break-glass local admin login page. URL is intentionally not linked from the main login page.

| Condition | Output |
|---|---|
| Already authenticated | `302 → /` |
| Default | Renders local login page |

---

## POST /local-login
Rate-limited (5 attempts / IP / 15 min). Validates credentials against `local_admins` table.

| Condition | Output |
|---|---|
| Missing username or password | Re-renders form with error |
| Username not found in DB | Re-renders form with generic "Invalid credentials" (no enumeration) |
| Account disabled | Re-renders form with generic error |
| Wrong password | Re-renders form with generic error; audit log entry written |
| Session regeneration fails | Re-renders form with error |
| Rate limit exceeded | `429` with message |
| Success | `302 → /` |

Local admin `AuthUser` has `isLocalAdmin: true`, `isSystemAdmin: false`, empty `groups` and `orgs`.

---

## POST /local-logout
Logs out a local admin session.

| Condition | Output |
|---|---|
| Always | `302 → /login` |

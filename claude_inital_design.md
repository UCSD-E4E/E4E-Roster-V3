Great inputs. Here's a full roadmap and architecture design for your lab roster platform.

---

## Stack Decision

**Backend:** Node.js (Express) — serves server-rendered pages and exposes API endpoints. Python scripts are invoked as child processes or called via a small Python microservice/helper layer. This keeps the web server in Node while preserving your existing Python tooling (Ansible playbooks, LDAP scripts, etc.) without rewriting them.

**Frontend:** Server-rendered via a lightweight templating engine (Jinja2-style but for Node — **Nunjucks** or **EJS**). No SPA complexity, no build pipeline needed. Plain HTML + minimal JS (Alpine.js or vanilla) for interactivity.

**Database:** A single lightweight **SQLite or Postgres** database as your platform's source of truth for roster metadata, project assignments, and audit logs. The authoritative identity data stays in your LDAP/SSO — the DB is supplementary.

---

## Architecture Overview

```
Browser
  │
  ▼
Node.js / Express  (server-rendered HTML via Nunjucks/EJS)
  │
  ├── SSO / OIDC middleware  ──────────────────▶  Your SSO (Univention LDAP)
  │
  ├── REST API layer
  │     ├── /api/users
  │     ├── /api/accounts/status
  │     └── /api/projects
  │
  └── Service layer
        ├── LDAP client  (ldapts npm package) ──▶  Univention LDAP
        ├── Python bridge  (child_process)  ──────▶  Ansible / custom scripts
        ├── GitHub API  (Octokit) ───────────────▶  GitHub Org
        └── Slack API  ──────────────────────────▶  Slack Org
```

The Python bridge is the key flexibility point. Any integration that already has a Python script (Ansible, server provisioning, etc.) is called as `python3 script.py --args` from Node and returns JSON on stdout. This means you never need to rewrite working automation.

---

## Site Map & Page Inventory

There are four core flows, each mapping to a section of the site.

### 1. Link User Flow — *"Check My Accounts"*
The entry point for students. A user logs in via SSO and the platform queries each integrated system to see what's missing.

- **`/check`** — Dashboard showing account status across all systems (GitHub org membership, Slack workspace, server accounts, SSO/LDAP entry). Each item is a green check or a red "missing" badge with a one-click provisioning button (admin) or a "request access" button (student).

### 2. SSO Login Flow
Standard OIDC/OAuth2 against your Univention SSO. Since Univention supports OIDC, this is a passport.js strategy (`passport-openidconnect`). No custom auth code.

- **`/login`** → redirects to SSO
- **`/auth/callback`** → handles the token, creates a session, redirects to `/dashboard`
- **`/logout`** → destroys session

### 3. Create New User Flow — *Admin only*
A form-driven wizard that provisions a new member across all systems in one action.

- **`/admin/users/new`** — Multi-step form:
  1. Basic info (name, email, username, role, PI/advisor)
  2. System selections (checkboxes: which server groups, which GitHub teams, Slack channels)
  3. Review & confirm
  4. Execution log — live-streamed output as each provisioning step runs (LDAP entry → Ansible → GitHub → Slack)

### 4. Data Portal — *"User Profile & Stats"*
A unified view per user showing everything about them.

- **`/dashboard`** — The logged-in user's own view: their account statuses, projects, recent activity.
- **`/admin/users`** — Admin table: full roster, filterable by role/status/project, bulk action support.
- **`/admin/users/:id`** — Admin detail view for any user: all accounts, project memberships, audit log of provisioning events.
- **`/projects`** — Project index showing all lab projects and their member lists.
- **`/projects/:id`** — Individual project page: members, linked GitHub repos, description.

---

## Role Model

Two roles to start, stored in your LDAP and reflected in the session:

| Role | Access |
|---|---|
| **Student** | `/dashboard`, `/check`, read-only `/projects` |
| **Admin / Staff** | Everything above + all `/admin/*` routes |

---

## Integration Points & Python Bridge Design

Each external system gets its own service module. The pattern is consistent: Node calls the integration, and if the integration is easier in Python, it shells out.

| System | Method | Notes |
|---|---|---|
| **Univention LDAP** | Node (`ldapts`) | Read/write users, groups directly |
| **Ansible / Server accounts** | Python bridge | Call existing playbooks, capture output |
| **GitHub Org** | Node (`@octokit/rest`) | Invite to org, add to teams |
| **Slack Org** | Node (`@slack/web-api`) | Invite by email |
| **Audit log** | SQLite/Postgres | Every provisioning action timestamped |

The Python bridge interface:
```
scripts/
  provision_server_account.py   # Called with --username --groups
  check_server_account.py       # Returns JSON: {exists: true, groups: [...]}
  deprovision_account.py
```
Node calls these with `child_process.spawn`, collects stdout JSON, and surfaces results to the UI.

---

## Phased Build Plan

**Phase 1 — Foundation (1–2 weeks)**
Set up Express + Nunjucks, SSO/OIDC login, session management, basic role middleware, and a skeleton of all the routes above. No integrations yet — stub everything with mock data so the UI is usable immediately.

**Phase 2 — Account Status & LDAP (1–2 weeks)**
Wire up the LDAP client. Build the `/check` page with real data. Add GitHub and Slack status checks (read-only first — just checking membership, no provisioning yet).

**Phase 3 — Provisioning (2–3 weeks)**
Build the new user wizard. Wire up the Python bridge for Ansible/server accounts. Add GitHub org invite and Slack invite. Add the execution log streaming (Server-Sent Events is simplest for this — no WebSocket complexity).

**Phase 4 — Data Portal & Admin Table (1–2 weeks)**
Build `/admin/users`, `/projects`, and the audit log. Add bulk actions (e.g. "add all members of project X to GitHub team Y"). Add the student-facing `/dashboard`.

**Phase 5 — Hardening**
Error handling for partial provisioning failures, retry logic, email notifications on account creation, and documentation for future maintainers.

---

## Key Design Principles to Carry Forward

- **LDAP is the source of truth** for identity. The platform reads from and writes to it — it doesn't maintain a parallel user store.
- **Idempotent provisioning.** Every "create account" action should check first and skip if it already exists. Your Python scripts should enforce this.
- **Audit everything.** Every provisioning action (who triggered it, what was done, success/fail) goes to the DB. This saves you when something goes wrong.
- **Fail gracefully per-system.** If GitHub is down, Slack and LDAP provisioning should still succeed and log the GitHub failure for retry.

---

When you're ready to start coding, the natural first file to build is the Express app skeleton with SSO login — that unlocks everything else. Want me to start there?


Good clarification — that actually simplifies things nicely. Here's how that changes the architecture:

---

## Revised Auth & Identity Model

**Authentik** handles all of the login UX and session token issuance. Your Node app never touches passwords or login forms — it just trusts Authentik as an OIDC provider. Authentik then keeps itself in sync with Univention LDAP behind the scenes, so you don't need to manage that sync yourself.

The only time your platform talks to LDAP directly is during **new user creation** — you write the new entry to Univention, Authentik picks it up via its sync, and the user can then log in.

---

## Revised Architecture

```
Browser
  │
  ├── Login ──────────────────────────────────▶  Authentik (OIDC)
  │                                               │
  │                                               ▼
  │                                          Univention LDAP
  │                                         (Authentik syncs this)
  │
  ▼
Node.js / Express
  │
  ├── OIDC middleware (passport-openidconnect) ──▶  Authentik
  │       Validates token, reads claims
  │       (username, email, groups/role from Authentik)
  │
  ├── Service layer
  │     ├── LDAP write client (ldapts) ──────────▶  Univention LDAP
  │     │       Only used for NEW user creation
  │     │
  │     ├── Python bridge (child_process) ────────▶  Ansible / server scripts
  │     ├── GitHub API (Octokit) ────────────────▶  GitHub Org
  │     └── Slack API ───────────────────────────▶  Slack Org
  │
  └── SQLite / Postgres  (roster metadata, projects, audit log)
```

---

## What Each System Is Responsible For

| Concern | Owner |
|---|---|
| Login / session / MFA | Authentik |
| User identity sync | Authentik ↔ Univention LDAP |
| New user creation | Your platform writes to Univention LDAP directly |
| Role/group claims in token | Authentik (reads from LDAP groups) |
| Server accounts | Ansible via Python bridge |
| GitHub / Slack membership | Node service layer |
| Roster metadata & projects | Your platform's DB |

---

## Impact on the Four Flows

**Login flow** — entirely delegated to Authentik. Your app just implements the OIDC callback, reads the claims (username, email, groups), and creates a session. No custom auth code beyond that.

**Link user flow** (`/check`) — unchanged. After login, query each system using the username from the Authentik token claims.

**New user flow** (`/admin/users/new`) — the first step writes a new entry to Univention LDAP via `ldapts`. After that, Authentik's sync takes over and the user will be able to log in within whatever your sync interval is (usually seconds to a few minutes). The rest of provisioning (GitHub, Slack, server accounts) runs in parallel as before.

**Data portal** — unchanged.

---

One thing worth confirming: **does Authentik expose group/role information in the OIDC token claims?** If your admin vs. student distinction is already modeled as LDAP groups that Authentik syncs and includes in the token, you get role-based access for free with no extra DB logic. If not, you'd need a small mapping layer. Worth checking your Authentik application configuration before building the role middleware.

Ready to start on the site map diagrams or jump into the first code?
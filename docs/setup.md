# Setup Guide

## Prerequisites

- [Node.js 20+](https://nodejs.org/) (local dev)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (full stack)
- An Authentik instance with an OIDC application configured — see [authentik.md](authentik.md)

---

## Local Development

Runs only the backend. You'll need a reachable Postgres instance (or use Docker just for the DB).

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in OIDC_* and SESSION_SECRET at minimum

# 3. Start the dev server (tsx watch mode)
npm run dev
```

Open http://localhost:3000. The server restarts automatically on file changes.

**Run just the database via Docker while developing locally:**
```bash
docker compose up db -d
```
Then add `DATABASE_URL=postgres://e4e:<DB_PASSWORD>@localhost:5432/e4e_roster` to `backend/.env`.

---

## Docker — Development (recommended)

Source files, templates, and static assets are mounted as volumes so the backend hot-reloads on save. Postgres persists across restarts without losing data.

```bash
# 1. Configure environment (first time only)
cp .env.example .env
# Edit .env — set NODE_ENV=dev, fill in OIDC_* and SESSION_SECRET at minimum

# 2. First run — builds the dev image
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Subsequent starts — no rebuild needed
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Rebuild the backend image (only needed after adding/removing npm packages)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up backend --build
```

The backend is available at http://localhost:3000. Edit any `.ts`, `.njk`, or `.css` file and the server restarts automatically inside the container.

---

## Docker — Production

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env — set NODE_ENV=production, fill in all values including DB_PASSWORD

# 2. Build and start
docker compose up --build

# Subsequent starts (no rebuild needed)
docker compose up

# Stop everything and remove volumes (resets the database)
docker compose down -v
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
### Server

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Long random string for signing session cookies |
| `PORT` | No | Port to listen on (default: `3000`) |
| `NODE_ENV` | No | Set to `production` for prod, anything else for dev (controls secure cookies) |

Generate a strong `SESSION_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Authentik OIDC

| Variable | Required | Description |
|---|---|---|
| `OIDC_ISSUER_URL` | Yes | Provider discovery URL — found in Authentik under **Applications → \<app\> → OpenID Configuration URL** |
| `OIDC_CLIENT_ID` | Yes | Client ID from the Authentik OAuth2 provider |
| `OIDC_CLIENT_SECRET` | Yes | Client secret from the Authentik OAuth2 provider |
| `OIDC_REDIRECT_URI` | Yes | Must exactly match a redirect URI registered in Authentik (e.g. `http://localhost:3000/auth/callback`) |
| `ADMIN_GROUP` | No | LDAP group name that grants admin access in the app (default: `e4e-admin`) |

See [authentik.md](authentik.md) for full setup steps.

### UDM REST API (Univention — user provisioning)

These are only needed for the admin user-creation flow. The app will start without them but provisioning will fail.

| Variable | Description | How to find it |
|---|---|---|
| `UDM_URL` | Base URL of the UDM REST API | `https://<your-univention-host>/univention/udm` — the same host Authentik syncs with |
| `UDM_ADMIN_USER` | Admin username | Typically `Administrator` |
| `UDM_ADMIN_PASSWORD` | Admin password | The Univention Administrator password |
| `UDM_USERS_POSITION` | LDAP container where new users are created | Univention default: `cn=users,dc=example,dc=com` |

**TLS certificate setup** (required if Univention uses a self-signed or internal CA):

```bash
# Extract the cert — run locally, not on the server
# < /dev/null closes stdin so openssl doesn't hang waiting for input
openssl s_client -connect your-univention-host:443 \
  -servername your-univention-host \
  -showcerts < /dev/null 2>/dev/null \
  | openssl x509 -out backend/certs/udm-ca.crt
```

Then set in `.env`:
```
NODE_EXTRA_CA_CERTS=/app/certs/udm-ca.crt
```

The `backend/certs/` directory is gitignored — never commit certificate files. The volume mount for this directory is already in `docker-compose.dev.yml`.

**Verify the API is reachable:**
```bash
curl -u Administrator:your-password \
  https://your-univention-host/univention/udm/users/user/?page_size=1
```
A JSON response confirms connectivity. A 401 means wrong credentials.

The interactive API browser at `https://<your-host>/univention/udm/` documents all available endpoints and lets you test requests directly.

**Groups in the new-user wizard** are fetched live from the UDM API — all groups in the directory appear as checkboxes. `ADMIN_GROUP` must match a group name here, since Authentik reads group membership from LDAP and includes it in the OIDC token.

### Database

| Variable | Required | Description |
|---|---|---|
| `DB_PASSWORD` | Docker only | Postgres password |
| `DB_NAME` | No | Database name (default: `e4e_roster`) |
| `DB_USER` | No | Postgres user (default: `e4e`) |

---

## Adding the Slack Bot Worker

When the `slackbot/` service is ready, uncomment the `slackbot` block in [docker-compose.yml](../docker-compose.yml). It shares the same `.env` file and depends on the `db` service.

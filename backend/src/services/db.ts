import { Pool } from 'pg';

export const db = new Pool({
  host: process.env.DB_HOST ?? 'db',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'e4e_roster',
  user: process.env.DB_USER ?? 'e4e',
  password: process.env.DB_PASSWORD,
});

export async function runMigrations(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // ── Users ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id             SERIAL PRIMARY KEY,
        username       VARCHAR(100) UNIQUE NOT NULL,
        first_name     VARCHAR(255),
        last_name      VARCHAR(255),
        email          VARCHAR(255),
        role           VARCHAR(50),
        expiry_date    DATE,
        disabled       BOOLEAN NOT NULL DEFAULT FALSE,
        ldap_groups    TEXT[]  NOT NULL DEFAULT '{}',
        ldap_dn        TEXT,
        last_synced_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username  VARCHAR(100)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_username   VARCHAR(100)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_email  VARCHAR(255)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone            VARCHAR(50)`);

    // ── Audit log ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id              SERIAL PRIMARY KEY,
        actor           VARCHAR(100) NOT NULL,
        target_username VARCHAR(100),
        action          VARCHAR(100) NOT NULL,
        details         JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Projects ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_ldap_groups (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ldap_group VARCHAR(255) NOT NULL,
        PRIMARY KEY (project_id, ldap_group)
      )
    `);

    // ── LDAP → service group mappings ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_mappings (
        id          SERIAL PRIMARY KEY,
        ldap_group  VARCHAR(255) NOT NULL,
        service     VARCHAR(20)  NOT NULL CHECK (service IN ('github', 'slack')),
        target_id   VARCHAR(255) NOT NULL,
        target_name VARCHAR(255) NOT NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (ldap_group, service, target_id)
      )
    `);

    // ── Orgs ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orgs (
        id          SERIAL PRIMARY KEY,
        slug        VARCHAR(100) UNIQUE NOT NULL,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── LDAP group → org role mappings ───────────────────────────────
    // Defines which LDAP groups grant which role in each org.
    // System admins configure this via the org settings UI.
    // Multiple groups can grant the same role (e.g. e4e-admin AND e4e-staff → org_admin).
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_ldap_group_mappings (
        id         SERIAL PRIMARY KEY,
        org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        ldap_group VARCHAR(255) NOT NULL,
        role       VARCHAR(50)  NOT NULL CHECK (role IN ('org_admin', 'project_lead', 'member')),
        created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (org_id, ldap_group)
      )
    `);

    // ── User ↔ Org membership ─────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_orgs (
        id        SERIAL PRIMARY KEY,
        username  VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        org_id    INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        role      VARCHAR(50) NOT NULL DEFAULT 'member'
                  CHECK (role IN ('org_admin', 'project_lead', 'member')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (username, org_id)
      )
    `);

    // ── Per-org integration configs (field-level encryption for secrets) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_integrations (
        id         SERIAL PRIMARY KEY,
        org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        service    VARCHAR(50) NOT NULL,
        config     JSONB NOT NULL DEFAULT '{}',
        enabled    BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (org_id, service)
      )
    `);

    // ── Local admin accounts (break-glass, non-SSO) ───────────────────
    // Created via BOOTSTRAP_ADMIN_* env vars on startup.
    // Deleted by a system admin through the /system/local-admins UI once SSO is working.
    await client.query(`
      CREATE TABLE IF NOT EXISTS local_admins (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(100) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        enabled       BOOLEAN NOT NULL DEFAULT TRUE,
        last_used_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Per-org UI theme ──────────────────────────────────────────────
    await client.query(`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS theme_color VARCHAR(7)`);

    // ── Add org_id FK to existing tables (nullable so old data survives) ─
    await client.query(`ALTER TABLE projects       ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES orgs(id)`);
    await client.query(`ALTER TABLE group_mappings ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES orgs(id)`);
    await client.query(`ALTER TABLE audit_log      ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES orgs(id)`);

    // ── Explicit LDAP group → org ownership ──────────────────────────────
    // Tracks which groups are visible/manageable within an org's admin panel.
    // Populated when an org admin creates a group, or a system admin assigns one.
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_groups (
        org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        ldap_group VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, ldap_group)
      )
    `);
    // Back-fill: any group already referenced in org_ldap_group_mappings belongs to that org
    await client.query(`
      INSERT INTO org_groups (org_id, ldap_group)
      SELECT org_id, ldap_group FROM org_ldap_group_mappings
      ON CONFLICT DO NOTHING
    `);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  console.log('[db] migrations complete');
}

// ── Org helpers ───────────────────────────────────────────────────────────────

export interface OrgRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  theme_color: string | null;
}

export interface OrgLdapGroupMappingRow {
  org_id: number;
  ldap_group: string;
  role: string;
}

export async function getAllOrgs(): Promise<OrgRow[]> {
  const { rows } = await db.query<OrgRow>(
    'SELECT id, slug, name, description, theme_color FROM orgs ORDER BY name',
  );
  return rows;
}

export async function getOrgBySlug(slug: string): Promise<OrgRow | null> {
  const { rows } = await db.query<OrgRow>(
    'SELECT id, slug, name, description, theme_color FROM orgs WHERE slug = $1',
    [slug],
  );
  return rows[0] ?? null;
}

// Returns all LDAP group → role mappings across all orgs, keyed by ldap_group.
// Used during login to derive org memberships from the OIDC token's groups claim.
export async function getAllOrgLdapMappings(): Promise<OrgLdapGroupMappingRow[]> {
  const { rows } = await db.query<OrgLdapGroupMappingRow>(`
    SELECT org_id, ldap_group, role FROM org_ldap_group_mappings
  `);
  return rows;
}

export interface UserOrgRow {
  org_id: number;
  org_slug: string;
  org_name: string;
  role: string;
}

export async function getUserOrgMemberships(username: string): Promise<UserOrgRow[]> {
  const { rows } = await db.query<UserOrgRow>(`
    SELECT uo.org_id, o.slug AS org_slug, o.name AS org_name, uo.role
    FROM user_orgs uo
    JOIN orgs o ON o.id = uo.org_id
    WHERE uo.username = $1
  `, [username]);
  return rows;
}

export async function upsertUserOrgMembership(
  username: string,
  orgId: number,
  role: string,
): Promise<void> {
  await db.query(`
    INSERT INTO user_orgs (username, org_id, role)
    VALUES ($1, $2, $3)
    ON CONFLICT (username, org_id) DO UPDATE SET role = EXCLUDED.role
  `, [username, orgId, role]);
}

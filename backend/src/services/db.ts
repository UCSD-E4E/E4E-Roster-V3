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

    // ── Users ─────────────────────────────────────────────────────────
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

    // ── Audit log ─────────────────────────────────────────────────────
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

    // ── Service group mappings ─────────────────────────────────────────
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

    // ── Orgs ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orgs (
        id          SERIAL PRIMARY KEY,
        slug        VARCHAR(100) UNIQUE NOT NULL,
        name        VARCHAR(255) NOT NULL,
        description TEXT,
        theme_color VARCHAR(7),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── System admin LDAP groups (extends SYSTEM_ADMIN_GROUP env var) ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_ldap_groups (
        ldap_group  VARCHAR(255) PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── Org-level LDAP group → role mappings ──────────────────────────
    // System admins define which LDAP groups grant which role within each org.
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

    // ── User ↔ org membership cache ───────────────────────────────────
    // Derived from LDAP groups at login and kept in sync. Not the source of truth —
    // the LDAP group memberships are. This is a read cache for fast role checks.
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_orgs (
        username  VARCHAR(100) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        org_id    INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        role      VARCHAR(50)  NOT NULL CHECK (role IN ('org_admin', 'project_lead', 'member')),
        joined_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY (username, org_id)
      )
    `);

    // ── Projects ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL UNIQUE,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_ldap_groups (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ldap_group VARCHAR(255) NOT NULL,
        PRIMARY KEY (project_id, ldap_group)
      )
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

export interface OrgMappingRow {
  org_id: number;
  ldap_group: string;
  role: string;
}

export interface UserOrgRow {
  org_id: number;
  org_slug: string;
  org_name: string;
  theme_color: string | null;
  role: string;
}

export async function getAllOrgs(): Promise<OrgRow[]> {
  const { rows } = await db.query<OrgRow>(
    `SELECT id, slug, name, description, theme_color FROM orgs ORDER BY name`,
  );
  return rows;
}

export async function getOrgBySlug(slug: string): Promise<OrgRow | null> {
  const { rows } = await db.query<OrgRow>(
    `SELECT id, slug, name, description, theme_color FROM orgs WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

export async function getAllOrgLdapMappings(): Promise<OrgMappingRow[]> {
  const { rows } = await db.query<OrgMappingRow>(
    `SELECT org_id, ldap_group, role FROM org_ldap_group_mappings`,
  );
  return rows;
}

export async function getUserOrgs(username: string): Promise<UserOrgRow[]> {
  const { rows } = await db.query<UserOrgRow>(
    `SELECT uo.org_id, o.slug AS org_slug, o.name AS org_name, o.theme_color, uo.role
     FROM user_orgs uo
     JOIN orgs o ON o.id = uo.org_id
     WHERE uo.username = $1
     ORDER BY o.name`,
    [username],
  );
  return rows;
}

export async function upsertUserOrg(username: string, orgId: number, role: string): Promise<void> {
  await db.query(
    `INSERT INTO user_orgs (username, org_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username, org_id) DO UPDATE SET role = EXCLUDED.role`,
    [username, orgId, role],
  );
}

export async function isSystemAdmin(ldapGroups: string[]): Promise<boolean> {
  const envGroup = process.env.SYSTEM_ADMIN_GROUP ?? process.env.ADMIN_GROUP ?? '';
  if (envGroup && ldapGroups.includes(envGroup)) return true;
  if (!ldapGroups.length) return false;
  const { rows } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM system_ldap_groups WHERE ldap_group = ANY($1)`,
    [ldapGroups],
  );
  return rows.length > 0;
}

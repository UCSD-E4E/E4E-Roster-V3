import { Pool } from 'pg';

export const db = new Pool({
  host: process.env.DB_HOST ?? 'db',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME ?? 'e4e_roster',
  user: process.env.DB_USER ?? 'e4e',
  password: process.env.DB_PASSWORD,
});

export async function runMigrations(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      VARCHAR(100) UNIQUE NOT NULL,
      first_name    VARCHAR(255),
      last_name     VARCHAR(255),
      email         VARCHAR(255),
      role          VARCHAR(50),
      expiry_date   DATE,
      disabled      BOOLEAN NOT NULL DEFAULT FALSE,
      ldap_groups   TEXT[]  NOT NULL DEFAULT '{}',
      ldap_dn       TEXT,
      last_synced_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS github_username VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_username  VARCHAR(100);

    CREATE TABLE IF NOT EXISTS audit_log (
      id               SERIAL PRIMARY KEY,
      actor            VARCHAR(100) NOT NULL,
      target_username  VARCHAR(100),
      action           VARCHAR(100) NOT NULL,
      details          JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_mappings (
      id           SERIAL PRIMARY KEY,
      ldap_group   VARCHAR(255) NOT NULL,
      service      VARCHAR(20)  NOT NULL CHECK (service IN ('github', 'slack')),
      target_id    VARCHAR(255) NOT NULL,
      target_name  VARCHAR(255) NOT NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (ldap_group, service, target_id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS project_ldap_groups (
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      ldap_group  VARCHAR(255) NOT NULL,
      PRIMARY KEY (project_id, ldap_group)
    );
  `);
  console.log('[db] migrations complete');
}

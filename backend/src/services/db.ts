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
  `);
  console.log('[db] migrations complete');
}

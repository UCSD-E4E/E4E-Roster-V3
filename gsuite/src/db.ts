import { Pool } from 'pg';

export const db = new Pool({
  host:     process.env.DB_HOST     ?? 'db',
  port:     parseInt(process.env.DB_PORT ?? '5432', 10),
  database: process.env.DB_NAME     ?? 'e4e_roster',
  user:     process.env.DB_USER     ?? 'e4e',
  password: process.env.DB_PASSWORD,
});

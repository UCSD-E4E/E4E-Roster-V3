import { db } from '../services/db';
import { decrypt } from '../services/crypto';

export type Service = 'slack' | 'github';
export interface Connection { orgId: number; service: Service; config: Record<string, string>; revision: string }

export function requireOrgId(orgId: number): void {
  if (!Number.isSafeInteger(orgId) || orgId < 1) throw new Error('An explicit organization is required.');
}

export async function connectionFor(orgId: number, service: Service): Promise<Connection> {
  requireOrgId(orgId);
  const { rows } = await db.query<{ config: Record<string, string>; revision: string }>(
    `SELECT config, updated_at::text AS revision FROM org_integrations WHERE org_id=$1 AND service=$2 AND enabled`, [orgId, service]);
  if (!rows[0]) throw new Error(`${service} is not enabled for this organization.`);
  const key = service === 'slack' ? 'teamId' : 'org';
  if (!rows[0].config[key]) throw new Error(`Incomplete ${service} connection.`);
  const { rowCount } = await db.query(`SELECT 1 FROM org_integrations WHERE service=$1 AND enabled AND LOWER(config->>$2)=LOWER($3)`,
    [service, key, rows[0].config[key]]);
  if (rowCount !== 1) throw new Error('Ambiguous integration connection.');
  return { orgId, service, ...rows[0] };
}

export async function resolveConnection(service: Service, key: 'teamId' | 'installationId', value: string, appId?: string): Promise<Connection> {
  const { rows } = await db.query<{ org_id: number; config: Record<string, string>; revision: string }>(
    `SELECT org_id, config, updated_at::text AS revision FROM org_integrations
     WHERE service=$1 AND enabled AND config->>$2=$3 AND ($4::text IS NULL OR config->>'appId'=$4)`,
    [service, key, value, appId ?? null]);
  if (rows.length !== 1) throw new Error('Unknown or ambiguous integration connection.');
  return { orgId: rows[0].org_id, service, config: rows[0].config, revision: rows[0].revision };
}

export function secret(connection: Connection, name: string): string {
  const value = connection.config[name];
  if (!value) throw new Error(`Missing ${connection.service} ${name}.`);
  return decrypt(value);
}

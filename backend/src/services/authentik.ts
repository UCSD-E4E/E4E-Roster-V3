import { randomUUID } from 'crypto';

export interface CollaboratorApplication { name: string; url: string }
export interface CollaboratorTenant {
  id: string;
  name: string;
  organizations: { id: string; name: string }[];
  applications: CollaboratorApplication[];
}
export interface CollaboratorCatalog { flow: string; flowSlug: string; tenants: CollaboratorTenant[] }
export interface CollaboratorInvite {
  url: string;
  email: string;
  tenant: string;
  org: string;
  expires: string;
  applications: CollaboratorApplication[];
}

export class AuthentikError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

function origin(): string {
  let url: URL;
  try { url = new URL(process.env.AUTHENTIK_URL ?? ''); } catch { throw new AuthentikError('AUTHENTIK_URL is not configured.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new AuthentikError('AUTHENTIK_URL must be an HTTPS origin.');
  }
  return url.origin;
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const token = process.env.AUTHENTIK_API_TOKEN;
  if (!token) throw new AuthentikError('The Authentik invitation API token is not configured.');
  let response: globalThis.Response;
  try {
    response = await fetch(`${origin()}/api/v3/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new AuthentikError(body
    ? 'The invitation request could not be confirmed. Ask an administrator to check Authentik before creating another invitation.'
    : 'Authentik could not be reached. Please try again.'); }
  if (!response.ok) {
    // Never forward provider response bodies: they can contain credentials or
    // invitation fixed_data, and are not safe product-facing error messages.
    throw new AuthentikError(response.status === 401 || response.status === 403
      ? 'Authentik rejected the roster API token. Ask a system administrator to check its permissions.'
      : `Authentik returned an error (${response.status}). Please contact a system administrator.`);
  }
  try { return await response.json(); } catch { throw new AuthentikError('Authentik returned an invalid response.'); }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const slug = /^[a-z0-9][a-z0-9-]{0,99}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export async function getCollaboratorCatalog(): Promise<CollaboratorCatalog> {
  const brandId = process.env.AUTHENTIK_BRAND_ID ?? '';
  if (!uuid.test(brandId)) throw new AuthentikError('AUTHENTIK_BRAND_ID is not configured.');
  const brand = object(await api(`core/brands/${brandId}/`));
  const raw = object(object(brand.attributes).roster_collaborators);
  if (typeof raw.flow !== 'string' || !uuid.test(raw.flow) || raw.flowSlug !== 'krg-collaborator-enrollment' || !Array.isArray(raw.tenants)) {
    throw new AuthentikError('The collaborator catalog is missing or invalid in Authentik.');
  }
  const tenants: CollaboratorTenant[] = raw.tenants.map((value: unknown) => {
    const tenant = object(value);
    if (typeof tenant.id !== 'string' || !slug.test(tenant.id) || typeof tenant.name !== 'string' || !Array.isArray(tenant.organizations) || !Array.isArray(tenant.applications)) throw new AuthentikError('Invalid Authentik tenant configuration.');
    const organizations = tenant.organizations.map((entry: unknown) => {
      const org = object(entry);
      if (typeof org.id !== 'string' || !slug.test(org.id) || typeof org.name !== 'string') throw new AuthentikError('Invalid Authentik organization configuration.');
      return { id: org.id, name: org.name };
    });
    const applications = tenant.applications.map((entry: unknown) => {
      const app = object(entry);
      let url: URL;
      try { url = new URL(String(app.url)); } catch { throw new AuthentikError('Invalid Authentik application link.'); }
      if (typeof app.name !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.origin === origin()) throw new AuthentikError('An application must have a direct HTTPS link outside Authentik.');
      return { name: app.name, url: url.href };
    });
    if (!organizations.length || !applications.length || new Set(organizations.map((org) => org.id)).size !== organizations.length) throw new AuthentikError('Incomplete Authentik tenant configuration.');
    return { id: tenant.id, name: tenant.name, organizations, applications };
  });
  if (new Set(tenants.map((tenant) => tenant.id)).size !== tenants.length) throw new AuthentikError('Duplicate Authentik tenant configuration.');
  return { flow: raw.flow, flowSlug: raw.flowSlug, tenants };
}

export async function createCollaboratorInvite(fields: { tenant: string; org: string; email: string; days: string }): Promise<CollaboratorInvite> {
  // Refetch on POST: hidden form values, stale pages, and arbitrary tenant/org
  // submissions cannot introduce grants absent from Authentik's current catalog.
  const catalog = await getCollaboratorCatalog();
  const tenant = catalog.tenants.find((entry) => entry.id === fields.tenant);
  if (!tenant?.organizations.some((org) => org.id === fields.org)) throw new AuthentikError('Choose an available tenant and organization.', 400);
  const email = fields.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthentikError('Enter a valid invitee email address.', 400);
  if (!/^(1|3|7|14|30)$/.test(fields.days)) throw new AuthentikError('Choose an invitation lifetime from the list.', 400);
  const expires = new Date(Date.now() + Number(fields.days) * 86400000).toISOString();
  const invitation = object(await api('stages/invitation/invitations/', {
    name: `roster-collab-${randomUUID()}`, flow: catalog.flow, single_use: true, expires,
    fixed_data: { 'attributes.tenant': tenant.id, 'attributes.org': fields.org, 'attributes.invited_email': email },
  }));
  if (typeof invitation.pk !== 'string' || !uuid.test(invitation.pk)) throw new AuthentikError('Authentik did not return a valid invitation token.');
  const url = new URL(`/if/flow/${catalog.flowSlug}/`, origin());
  url.searchParams.set('itoken', invitation.pk);
  return { url: url.href, email, tenant: tenant.name, org: tenant.organizations.find((org) => org.id === fields.org)!.name, expires, applications: tenant.applications };
}

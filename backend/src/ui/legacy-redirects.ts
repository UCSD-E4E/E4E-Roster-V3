import type { Request, Response } from 'express';

function query(req: Request): string {
  const index = req.originalUrl.indexOf('?');
  return index === -1 ? '' : req.originalUrl.slice(index);
}

export function legacyOrgDestination(base: string, path: string): string | null {
  if (path === '/dashboard') return `${base}/v2/dashboard`;
  if (path === '/account') return `${base}/v2/account`;
  if (/^\/admin(?:\/users)?\/?$/.test(path)) return `${base}/v2/people`;
  if (path === '/admin/users/add') return `${base}/v2/people/add`;
  if (path === '/admin/users/new') return `${base}/v2/people/new`;
  const adminUser = path.match(/^\/admin\/users\/([^/]+)\/edit$/);
  if (adminUser) return `${base}/v2/people/${encodeURIComponent(adminUser[1])}/edit`;
  if (/^\/admin\/projects\/?$/.test(path)) return `${base}/v2/projects`;
  if (path === '/admin/projects/new') return `${base}/v2/projects/new`;
  const adminProject = path.match(/^\/admin\/projects\/(\d+)(?:\/.*)?$/);
  if (adminProject) return `${base}/v2/projects/${adminProject[1]}`;
  if (/^\/admin\/(groups|integrations)\/?/.test(path)) return `${base}/v2/settings/groups`;
  if (/^\/admin\/settings\/?/.test(path)) return `${base}/v2/settings`;
  if (path === '/pl' || path === '/pl/' || path === '/pl/projects') return `${base}/v2/projects`;
  const projectUser = path.match(/^\/pl\/projects\/(\d+)\/users(?:\/(.*))?$/);
  if (projectUser) {
    const [, projectId, tail] = projectUser;
    if (!tail) return `${base}/v2/projects/${projectId}`;
    if (tail === 'add') return `${base}/v2/projects/${projectId}/members/add`;
    if (tail === 'new') return `${base}/v2/projects/${projectId}/members/new`;
    const audit = tail.match(/^([^/]+)\/audit$/);
    if (audit) return `${base}/v2/projects/${projectId}/members/${encodeURIComponent(audit[1])}/audit`;
    const edit = tail.match(/^([^/]+)\/edit$/);
    if (edit) return `${base}/v2/projects/${projectId}/members/${encodeURIComponent(edit[1])}/edit`;
    return `${base}/v2/projects/${projectId}`;
  }
  return null;
}

export function legacySystemDestination(path: string): string | null {
  if (path === '/' || path === '') return '/system/v2/local-admins';
  if (path === '/local-admins') return '/system/v2/local-admins';
  if (path === '/users') return '/system/v2/users';
  if (path === '/users/new') return '/system/v2/users/new';
  const user = path.match(/^\/users\/([^/]+)\/edit$/);
  if (user) return `/system/v2/users/${encodeURIComponent(user[1])}/edit`;
  if (path === '/groups/new') return '/system/v2/groups/new';
  if (path === '/audit') return '/system/v2/audit';
  if (path === '/orgs') return '/system/v2/organizations';
  const mappings = path.match(/^\/orgs\/(\d+)\/ldap-mappings$/);
  if (mappings) return `/system/v2/organizations/${mappings[1]}/mappings`;
  return null;
}

export function retireLegacyOrgUi(req: Request, res: Response): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(410).type('text').send('Legacy roster endpoint retired. Use the React workspace.');
    return;
  }
  const destination = legacyOrgDestination(res.locals.orgBase, req.path);
  if (!destination) { res.status(404).type('text').send('Route not found.'); return; }
  res.redirect(302, `${destination}${query(req)}`);
}

export function retireLegacySystemUi(req: Request, res: Response): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(410).type('text').send('Legacy roster endpoint retired. Use system administration v2.');
    return;
  }
  const destination = legacySystemDestination(req.path);
  if (!destination) { res.status(404).type('text').send('Route not found.'); return; }
  res.redirect(302, `${destination}${query(req)}`);
}

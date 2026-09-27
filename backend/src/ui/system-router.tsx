import { Router, type NextFunction, type Request as ExpressRequest, type Response } from 'express';
import { renderToString } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, data, redirect, StaticRouterProvider, type RouteObject } from 'react-router';
import { SystemAuditPage, SystemGroupProvisionPage, SystemLdapMappingsPage, SystemLocalAdminsPage, SystemOrganizationsPage, SystemRouteError, SystemShell, SystemUserCreatePage, SystemUserEditPage, SystemUserProvisionResultPage, SystemUsersPage } from './system-components';
import { addSystemLdapMapping, createLocalAdmin, createSystemOrganization, deleteLocalAdmin, deleteSystemLdapMapping, deleteSystemOrganization, getSystemGroupProvisioningOptions, getSystemLdapMappings, getSystemUserEdit, listLocalAdmins, listSystemAudit, listSystemDirectoryGroups, listSystemOrganizations, listSystemUsers, provisionSystemGroup, provisionSystemUser, syncSystemDirectory, syncSystemLdapMappings, type SystemUiContext, toggleLocalAdmin, updateSystemLdapMappingRole, updateSystemOrganizationTheme, updateSystemUser } from './system.server';
import { requireSameOriginMutation, setReactWorkspaceHeaders } from './security';

function contextFromExpress(req: ExpressRequest): SystemUiContext {
  if (!req.user) throw new Error('System UI requires an authenticated user.');
  return { user: req.user, basePath: '/system/v2' };
}

function formFields(form: FormData): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  form.forEach((value, key) => {
    const existing = fields[key];
    fields[key] = existing === undefined ? String(value) : [...(Array.isArray(existing) ? existing : [existing]), String(value)];
  });
  return fields;
}

function routesFor(context: SystemUiContext, req: ExpressRequest): RouteObject[] {
  return [{ path: '/', element: <SystemShell />, loader: () => ({ context }), errorElement: <SystemRouteError />, children: [
    { index: true, loader: () => redirect('/local-admins') },
    { path: 'local-admins', element: <SystemLocalAdminsPage />, errorElement: <SystemRouteError />, loader: async () => ({ admins: await listLocalAdmins(), context }), action: async ({ request }) => {
      const form = await request.formData(); const intent = String(form.get('intent') ?? ''); const id = Number(form.get('id'));
      if (intent === 'create') await createLocalAdmin(String(form.get('username') ?? ''), String(form.get('password') ?? ''));
      else if (intent === 'toggle') await toggleLocalAdmin(id);
      else if (intent === 'delete') await deleteLocalAdmin(id, form.get('confirm') === 'delete');
      else throw data('Unknown local administrator action.', { status: 400 });
      return redirect('/local-admins');
    } },
    { path: 'organizations', element: <SystemOrganizationsPage />, errorElement: <SystemRouteError />, loader: async () => ({ organizations: await listSystemOrganizations(), context }), action: async ({ request }) => {
      const form = await request.formData(); const intent = String(form.get('intent') ?? ''); const id = Number(form.get('id'));
      if (intent === 'create') await createSystemOrganization({ slug: String(form.get('slug') ?? ''), name: String(form.get('name') ?? ''), description: String(form.get('description') ?? ''), themeColor: String(form.get('themeColor') ?? '') });
      else if (intent === 'theme') await updateSystemOrganizationTheme(id, String(form.get('themeColor') ?? ''));
      else if (intent === 'delete') await deleteSystemOrganization(id, form.get('confirm') === 'delete');
      else throw data('Unknown organization action.', { status: 400 });
      return redirect('/organizations');
    } },
    { path: 'audit', element: <SystemAuditPage />, errorElement: <SystemRouteError />, loader: async ({ request }) => ({ audit: await listSystemAudit(Number(new URL(request.url).searchParams.get('days') ?? '7')), context }) },
    { path: 'users', element: <SystemUsersPage />, errorElement: <SystemRouteError />, loader: async ({ request }) => { const search = new URL(request.url).searchParams; return { users: await listSystemUsers(search.get('sort') ?? undefined, search.get('dir') ?? undefined), sync: search.get('sync'), sort: search.get('sort') ?? 'name', direction: search.get('dir') === 'desc' ? 'desc' : 'asc', context }; }, action: async ({ request }) => {
      const form = await request.formData();
      if (String(form.get('intent')) !== 'sync') throw data('Unknown directory action.', { status: 400 });
      const result = await syncSystemDirectory();
      return redirect(`/users?sync=${result.synced},${result.removed},${result.errors}`);
    } },
    { path: 'users/new', element: <SystemUserCreatePage />, errorElement: <SystemRouteError />, loader: async () => ({ groups: await listSystemDirectoryGroups(), context }), action: async ({ request }) => {
      const form = await request.formData(); req.session.systemProvisionResult = await provisionSystemUser(context.user.username, formFields(form));
      return redirect('/users/new/result');
    } },
    { path: 'users/new/result', element: <SystemUserProvisionResultPage />, errorElement: <SystemRouteError />, loader: () => {
      const result = req.session.systemProvisionResult; delete req.session.systemProvisionResult;
      if (!result) throw data('No recent directory-user provisioning result was found.', { status: 404 });
      return { result, context };
    } },
    { path: 'users/:username/edit', element: <SystemUserEditPage />, errorElement: <SystemRouteError />, loader: async ({ params }) => {
      if (!params.username) throw data('Invalid directory user.', { status: 400 }); const [user, groups] = await Promise.all([getSystemUserEdit(params.username), listSystemDirectoryGroups()]);
      if (!user) throw data('Directory user not found.', { status: 404 }); return { user, groups, context };
    }, action: async ({ params, request }) => {
      if (!params.username) throw data('Invalid directory user.', { status: 400 }); const form = await request.formData();
      await updateSystemUser(context.user.username, params.username, formFields(form)); return redirect('/users');
    } },
    { path: 'groups/new', element: <SystemGroupProvisionPage />, errorElement: <SystemRouteError />, loader: async () => ({ options: await getSystemGroupProvisioningOptions(), context }), action: async ({ request }) => {
      const result = await provisionSystemGroup(context.user.username, formFields(await request.formData()));
      return redirect(`/groups/new?created=${encodeURIComponent(result.name)}`);
    } },
    { path: 'organizations/:orgId/mappings', element: <SystemLdapMappingsPage />, errorElement: <SystemRouteError />, loader: async ({ params, request }) => {
      const orgId = Number(params.orgId); const mappings = await getSystemLdapMappings(orgId); if (!mappings) throw data('Organization not found.', { status: 404 });
      return { mappings, synced: new URL(request.url).searchParams.get('synced'), context };
    }, action: async ({ params, request }) => {
      const orgId = Number(params.orgId); const form = await request.formData(); const intent = String(form.get('intent') ?? ''); const mappingId = Number(form.get('mappingId'));
      if (intent === 'add') await addSystemLdapMapping(orgId, String(form.get('ldapGroup') ?? ''), String(form.get('role') ?? ''));
      else if (intent === 'role') await updateSystemLdapMappingRole(orgId, mappingId, String(form.get('role') ?? ''));
      else if (intent === 'delete') await deleteSystemLdapMapping(orgId, mappingId);
      else if (intent === 'sync') { const count = await syncSystemLdapMappings(orgId, context.user.username); return redirect(`/organizations/${orgId}/mappings?synced=${count}`); }
      else throw data('Unknown LDAP mapping action.', { status: 400 });
      return redirect(`/organizations/${orgId}/mappings`);
    } },
  ] }];
}

function webRequest(req: ExpressRequest): globalThis.Request {
  const protocol = req.protocol || 'http'; const host = req.get('host') ?? 'localhost'; const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) { if (typeof value === 'string') headers.set(name, value); else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item)); }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') { const body = new URLSearchParams(); for (const [name, value] of Object.entries(req.body as Record<string, unknown>)) for (const item of Array.isArray(value) ? value : [value]) if (item != null) body.append(name, String(item)); init.body = body; headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8'); }
  return new globalThis.Request(`${protocol}://${host}${req.originalUrl}`, init);
}

export function createReactSystemRouter(): Router {
  const router = Router();
  router.use(setReactWorkspaceHeaders);
  router.use(requireSameOriginMutation);
  router.all('*', async (req: ExpressRequest, res: Response, next: NextFunction) => { try {
    const context = contextFromExpress(req); const { query, dataRoutes } = createStaticHandler(routesFor(context, req), { basename: context.basePath }); const result = await query(webRequest(req));
    if (result instanceof globalThis.Response) { result.headers.forEach((value, name) => res.setHeader(name, value)); res.status(result.status).send(Buffer.from(await result.arrayBuffer())); return; }
    const markup = renderToString(<StaticRouterProvider router={createStaticRouter(dataRoutes, result)} context={result} hydrate={false} />); res.status(result.statusCode).type('html').send(`<!DOCTYPE html>${markup}`);
  } catch (error) { next(error); } });
  return router;
}

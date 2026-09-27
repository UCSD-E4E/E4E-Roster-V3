import { Router, Request as ExpressRequest, Response, NextFunction } from 'express';
import { renderToString } from 'react-dom/server';
import {
  createStaticHandler,
  createStaticRouter,
  data,
  redirect,
  StaticRouterProvider,
  type RouteObject,
} from 'react-router';
import { AccountPage, DashboardPage, GroupMappingsPage, PeopleAddPage, PeopleCreatePage, PeopleEditPage, PeoplePage, PersonProvisionResultPage, ProjectAddPersonPage, ProjectAuditPage, ProjectCreatePage, ProjectCreatePersonPage, ProjectMemberEditPage, ProjectPage, ProjectSettingsPage, ProjectsPage, RosterShell, RouteErrorPage, SettingsPage } from './components';
import { addProjectGroup, createProject, getProject, getProjectMemberAudit, getProjectMemberEdit, getProjectSettings, listProjects, removeProjectGroup, RosterUiContext, updateProject } from './projects.server';
import { getOrgPersonEdit, listOrgGroups, listPeople, searchDirectoryPeople, searchPeople, syncOrganizationDirectory } from './people.server';
import { addOrgGroupIntegrationMapping, createOrganizationGroup, getIntegrationSettings, getOrgGroupMappingSettings, removeOrgGroupIntegrationMapping, setOrgGroupRole, syncOrganizationIntegrations, updateGithubSettings, updateSlackSettings } from './settings.server';
import { getAccountProfile, updateAccountProfile } from './account.server';
import { getDashboardSummary } from './dashboard.server';
import { addOrganizationPerson, updateOrganizationPerson } from './people-write.server';
import { addProjectMember, updateProjectMember } from './project-write.server';
import { keepFormError } from './action-errors';
import { provisionOrganizationPerson, provisionProjectPerson } from './roster-provision.server';
import { requireSameOriginMutation, setReactWorkspaceHeaders } from './security';

function contextFromExpress(req: ExpressRequest, res: Response): RosterUiContext {
  if (!req.user || !req.currentOrg || !req.currentOrgMembership) {
    throw new Error('React roster routes require authenticated organisation context.');
  }
  return {
    user: req.user,
    org: {
      id: req.currentOrg.id,
      slug: req.currentOrg.slug,
      name: req.currentOrg.name,
      themeColor: req.currentOrg.theme_color,
    },
    membership: req.currentOrgMembership,
    basePath: `${res.locals.orgBase}/v2`,
  };
}

function formFields(form: FormData): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  form.forEach((value, key) => { const current = fields[key]; fields[key] = current === undefined ? String(value) : [...(Array.isArray(current) ? current : [current]), String(value)]; });
  return fields;
}

function routesFor(context: RosterUiContext, req: ExpressRequest): RouteObject[] {
  return [{
    path: '/',
    element: <RosterShell />,
    errorElement: <RouteErrorPage />,
    loader: () => ({ context }),
    children: [
      { index: true, loader: () => redirect('/dashboard') },
      {
        path: 'dashboard',
        element: <DashboardPage />,
        errorElement: <RouteErrorPage />,
        loader: () => ({ summary: getDashboardSummary(context), context }),
      },
      {
        path: 'account',
        element: <AccountPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ request }) => ({
          profile: await getAccountProfile(context),
          saved: new URL(request.url).searchParams.get('saved') === '1',
          context,
        }),
        action: ({ request }) => keepFormError(async () => {
          const form = await request.formData();
          await updateAccountProfile(context, {
            secondaryEmail: String(form.get('secondaryEmail') ?? ''),
            phone: String(form.get('phone') ?? ''),
            sshKeys: String(form.get('sshKeys') ?? ''),
          });
          return redirect('/account?saved=1');
        }),
      },
      {
        path: 'projects',
        element: <ProjectsPage />,
        errorElement: <RouteErrorPage />,
        loader: async () => ({ projects: await listProjects(context), context }),
      },
      {
        path: 'projects/new',
        element: <ProjectCreatePage />,
        errorElement: <RouteErrorPage />,
        action: async ({ request }) => {
          const form = await request.formData();
          const name = String(form.get('name') ?? '').trim();
          const description = String(form.get('description') ?? '').trim() || null;
          if (!name) throw data('Project name is required.', { status: 400 });
          const projectId = await createProject(context, { name, description });
          return redirect(`/projects/${projectId}/settings`);
        },
      },
      {
        path: 'people',
        element: <PeoplePage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ request }) => { const search = new URL(request.url).searchParams; return { people: await listPeople(context, search.get('sort') ?? undefined, search.get('dir') ?? undefined), sync: search.get('sync'), sort: search.get('sort') ?? 'name', direction: search.get('dir') === 'desc' ? 'desc' : 'asc', context }; },
        action: ({ request }) => keepFormError(async () => {
          const form = await request.formData();
          if (String(form.get('intent')) !== 'sync') throw data('Unknown people action.', { status: 400 });
          const result = await syncOrganizationDirectory(context);
          return redirect(`/people?sync=${result.synced},${result.removed},${result.errors}`);
        }),
      },
      {
        path: 'people/add',
        element: <PeopleAddPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ request }) => {
          const query = new URL(request.url).searchParams.get('q') ?? '';
          return { query, results: await searchPeople(context, query), context };
        },
        action: ({ request }) => keepFormError(async () => {
          const form = await request.formData();
          await addOrganizationPerson(context, String(form.get('username') ?? ''), String(form.get('role') ?? ''));
          return redirect('/people');
        }),
      },
      {
        path: 'people/new',
        element: <PeopleCreatePage />,
        errorElement: <RouteErrorPage />,
        loader: async () => ({ groups: await listOrgGroups(context), context }),
        action: ({ request }) => keepFormError(async () => {
          req.session.rosterProvisionResult = await provisionOrganizationPerson(context, formFields(await request.formData()));
          return redirect('/people/new/result');
        }),
      },
      { path: 'people/new/result', element: <PersonProvisionResultPage />, errorElement: <RouteErrorPage />, loader: () => {
        const result = req.session.rosterProvisionResult; delete req.session.rosterProvisionResult;
        if (!result) throw data('No recent person-provisioning result was found.', { status: 404 }); return { result, returnTo: '/people', context };
      } },
      {
        path: 'people/:username/edit',
        element: <PeopleEditPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          if (!params.username) throw data('Invalid username.', { status: 400 });
          const edit = await getOrgPersonEdit(context, params.username);
          if (!edit) throw data('Person not found.', { status: 404 });
          return { ...edit, context };
        },
        action: ({ params, request }) => keepFormError(async () => {
          if (!params.username) throw data('Invalid username.', { status: 400 });
          const form = await request.formData();
          await updateOrganizationPerson(context, params.username, {
            firstName: String(form.get('firstName') ?? ''), lastName: String(form.get('lastName') ?? ''),
            email: String(form.get('email') ?? ''), role: String(form.get('role') ?? ''),
            expiryDate: String(form.get('expiryDate') ?? ''), groups: form.getAll('groups').map(String),
            githubUsername: String(form.get('githubUsername') ?? ''), slackUsername: String(form.get('slackUsername') ?? ''),
            secondaryEmail: String(form.get('secondaryEmail') ?? ''), phone: String(form.get('phone') ?? ''), sshKeys: String(form.get('sshKeys') ?? ''),
          });
          return redirect('/people');
        }),
      },
      {
        path: 'settings',
        element: <SettingsPage />,
        errorElement: <RouteErrorPage />,
        loader: async () => ({ settings: await getIntegrationSettings(context), context }),
        action: ({ request }) => keepFormError(async () => {
          const form = await request.formData();
          const intent = String(form.get('intent') ?? '');
          if (intent === 'github') {
            await updateGithubSettings(context, { enabled: form.get('enabled') === 'true', appId: String(form.get('appId') ?? '').trim(), installationId: String(form.get('installationId') ?? '').trim(), org: String(form.get('org') ?? '').trim(), privateKey: String(form.get('privateKey') ?? '').trim() });
          } else if (intent === 'slack') {
            await updateSlackSettings(context, { enabled: form.get('enabled') === 'true', teamId: String(form.get('teamId') ?? '').trim(), botToken: String(form.get('botToken') ?? '').trim() });
          } else throw data('Unknown settings action.', { status: 400 });
          return redirect('/settings');
        }),
      },
      { path: 'settings/groups', element: <GroupMappingsPage />, errorElement: <RouteErrorPage />, loader: async ({ request }) => ({ mappings: await getOrgGroupMappingSettings(context, new URL(request.url).searchParams.get('group')), context }), action: ({ request }) => keepFormError(async () => {
        const form = await request.formData(); const intent = String(form.get('intent') ?? ''); const group = String(form.get('ldapGroup') ?? '');
        if (intent === 'create') {
          const created = await createOrganizationGroup(context, { name: String(form.get('groupName') ?? ''), projectId: String(form.get('projectId') ?? '') });
          return redirect(`/settings/groups?group=${encodeURIComponent(created)}`);
        } else if (intent === 'role') await setOrgGroupRole(context, group, String(form.get('role') ?? ''));
        else if (intent === 'add') await addOrgGroupIntegrationMapping(context, { ldapGroup: group, service: String(form.get('service') ?? ''), targetId: String(form.get('targetId') ?? ''), targetName: String(form.get('targetName') ?? '') });
        else if (intent === 'delete') await removeOrgGroupIntegrationMapping(context, Number(form.get('id')));
        else if (intent === 'sync') { await syncOrganizationIntegrations(context); }
        else throw data('Unknown group mapping action.', { status: 400 });
        return redirect(`/settings/groups?group=${encodeURIComponent(group)}`);
      }) },
      {
        path: 'projects/:projectId',
        element: <ProjectPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const project = await getProject(context, projectId);
          if (!project) throw data('Project not found.', { status: 404 });
          return { project, context };
        },
        action: ({ request, params }) => keepFormError(async () => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const form = await request.formData();
          const name = String(form.get('name') ?? '').trim();
          const description = String(form.get('description') ?? '').trim() || null;
          if (!name) throw data('Project name is required.', { status: 400 });
          const updated = await updateProject(context, projectId, { name, description });
          if (!updated) throw data('Project not found.', { status: 404 });
          return redirect(`/projects/${projectId}`);
        }),
      },
      {
        path: 'projects/:projectId/members/:username/audit',
        element: <ProjectAuditPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId) || !params.username) throw data('Invalid project member.', { status: 400 });
          const audit = await getProjectMemberAudit(context, projectId, params.username);
          if (!audit) throw data('Project member not found.', { status: 404 });
          return { audit, context };
        },
      },
      {
        path: 'projects/:projectId/members/add',
        element: <ProjectAddPersonPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params, request }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const project = await getProject(context, projectId);
          if (!project) throw data('Project not found.', { status: 404 });
          const query = new URL(request.url).searchParams.get('q') ?? '';
          return { project, query, results: await searchDirectoryPeople(context, query), context };
        },
        action: ({ params, request }) => keepFormError(async () => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const form = await request.formData();
          await addProjectMember(context, projectId, String(form.get('username') ?? ''), form.getAll('groups').map(String));
          return redirect(`/projects/${projectId}`);
        }),
      },
      {
        path: 'projects/:projectId/members/new',
        element: <ProjectCreatePersonPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const project = await getProject(context, projectId);
          if (!project) throw data('Project not found.', { status: 404 });
          return { project, context };
        },
        action: ({ params, request }) => keepFormError(async () => {
          const projectId = Number(params.projectId); if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          req.session.rosterProvisionResult = await provisionProjectPerson(context, projectId, formFields(await request.formData()));
          return redirect(`/projects/${projectId}/members/new/result`);
        }),
      },
      { path: 'projects/:projectId/members/new/result', element: <PersonProvisionResultPage />, errorElement: <RouteErrorPage />, loader: ({ params }) => {
        const projectId = Number(params.projectId); if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 }); const result = req.session.rosterProvisionResult; delete req.session.rosterProvisionResult;
        if (!result) throw data('No recent person-provisioning result was found.', { status: 404 }); return { result, returnTo: `/projects/${projectId}`, context };
      } },
      {
        path: 'projects/:projectId/members/:username/edit',
        element: <ProjectMemberEditPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId) || !params.username) throw data('Invalid project member.', { status: 400 });
          const edit = await getProjectMemberEdit(context, projectId, params.username);
          if (!edit) throw data('Project member not found.', { status: 404 });
          return { ...edit, context };
        },
        action: ({ params, request }) => keepFormError(async () => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId) || !params.username) throw data('Invalid project member.', { status: 400 });
          const form = await request.formData();
          await updateProjectMember(context, projectId, params.username, {
            groups: form.getAll('groups').map(String), githubUsername: String(form.get('githubUsername') ?? ''),
            slackUsername: String(form.get('slackUsername') ?? ''), secondaryEmail: String(form.get('secondaryEmail') ?? ''),
            phone: String(form.get('phone') ?? ''), disabled: String(form.get('disabled') ?? 'false'),
            sshKeys: String(form.get('sshKeys') ?? ''),
          });
          return redirect(`/projects/${projectId}`);
        }),
      },
      {
        path: 'projects/:projectId/settings',
        element: <ProjectSettingsPage />,
        errorElement: <RouteErrorPage />,
        loader: async ({ params }) => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const settings = await getProjectSettings(context, projectId);
          if (!settings) throw data('Project not found.', { status: 404 });
          return { settings, context };
        },
        action: ({ request, params }) => keepFormError(async () => {
          const projectId = Number(params.projectId);
          if (!Number.isInteger(projectId)) throw data('Invalid project ID.', { status: 400 });
          const settings = await getProjectSettings(context, projectId);
          if (!settings) throw data('Project not found.', { status: 404 });
          const form = await request.formData();
          const intent = String(form.get('intent') ?? '');
          if (intent === 'update-project') {
            const name = String(form.get('name') ?? '').trim();
            const description = String(form.get('description') ?? '').trim() || null;
            if (!name) throw data('Project name is required.', { status: 400 });
            await updateProject(context, projectId, { name, description });
          } else if (intent === 'add-group') {
            const ldapGroup = String(form.get('ldapGroup') ?? '');
            if (!settings.orgGroups.includes(ldapGroup)) {
              throw data('LDAP group does not belong to this organization.', { status: 400 });
            }
            await addProjectGroup(context, projectId, ldapGroup);
          } else if (intent === 'remove-group') {
            const ldapGroup = String(form.get('ldapGroup') ?? '');
            if (!settings.project.groups.includes(ldapGroup)) {
              throw data('LDAP group is not assigned to this project.', { status: 400 });
            }
            await removeProjectGroup(context, projectId, ldapGroup);
          } else {
            throw data('Unknown project settings action.', { status: 400 });
          }
          return redirect(`/projects/${projectId}/settings`);
        }),
      },
    ],
  }];
}

function webRequest(req: ExpressRequest): globalThis.Request {
  const protocol = req.protocol || 'http';
  const host = req.get('host') ?? 'localhost';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(req.body as Record<string, unknown>)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null) body.append(name, String(item));
      }
    }
    init.body = body;
    headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
  }
  return new globalThis.Request(`${protocol}://${host}${req.originalUrl}`, init);
}

async function sendFetchResponse(response: globalThis.Response, res: Response): Promise<void> {
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.status(response.status);
  const body = await response.arrayBuffer();
  res.send(Buffer.from(body));
}

export function createReactRosterRouter(): Router {
  const router = Router({ mergeParams: true });
  router.use(setReactWorkspaceHeaders);
  router.use(requireSameOriginMutation);
  router.all('*', async (req: ExpressRequest, res: Response, next: NextFunction) => {
    try {
      const context = contextFromExpress(req, res);
      const { query, dataRoutes } = createStaticHandler(routesFor(context, req), { basename: context.basePath });
      const result = await query(webRequest(req));
      if (result instanceof globalThis.Response) {
        await sendFetchResponse(result, res);
        return;
      }

      const staticRouter = createStaticRouter(dataRoutes, result);
      const markup = renderToString(
        <StaticRouterProvider router={staticRouter} context={result} hydrate={false} />,
      );
      res.status(result.statusCode).type('html').send(`<!DOCTYPE html>${markup}`);
    } catch (err) {
      next(err);
    }
  });
  return router;
}

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import * as ldap from '../src/services/ldap';
import { createApp } from '../src/app';
import { db, ensureUserOrgMembership, runMigrations } from '../src/services/db';
import { AuthUser } from '../src/types/user';

type Fixture = {
  alphaId: number;
  betaId: number;
  alphaProjectId: number;
  betaProjectId: number;
};

const users = new Map<string, AuthUser>([
  ['alpha-admin', {
    id: 'alpha-admin', name: 'Alpha Admin', email: 'alpha-admin@example.test', username: 'alpha-admin',
    groups: ['alpha-team'], isSystemAdmin: false,
    orgs: [{ orgId: 0, orgSlug: 'alpha', orgName: 'Alpha', role: 'org_admin' }],
  }],
  ['beta-admin', {
    id: 'beta-admin', name: 'Beta Admin', email: 'beta-admin@example.test', username: 'beta-admin',
    groups: ['beta-team'], isSystemAdmin: false,
    orgs: [{ orgId: 0, orgSlug: 'beta', orgName: 'Beta', role: 'org_admin' }],
  }],
  ['alpha-lead', {
    id: 'alpha-lead', name: 'Alpha Lead', email: 'alpha-lead@example.test', username: 'alpha-lead',
    groups: ['alpha-team'], isSystemAdmin: false,
    orgs: [{ orgId: 0, orgSlug: 'alpha', orgName: 'Alpha', role: 'project_lead' }],
  }],
  ['alpha-member', {
    id: 'alpha-member', name: 'Alpha Member', email: 'alpha-member@example.test', username: 'alpha-member',
    groups: ['alpha-team', 'shared'], isSystemAdmin: false,
    orgs: [{ orgId: 0, orgSlug: 'alpha', orgName: 'Alpha', role: 'member' }],
  }],
  ['local-admin', {
    id: 'local:admin', name: 'Local Admin', email: 'local-admin@example.test', username: 'local-admin',
    groups: [], isSystemAdmin: false, isLocalAdmin: true, orgs: [],
  }],
]);

let fixture: Fixture;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;

function request(path: string, username: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...init,
    headers: { Origin: baseUrl, 'x-test-user': username, ...init.headers },
  });
}

before(async () => {
  await runMigrations();
  await db.query('TRUNCATE audit_log, local_admins, project_ldap_groups, user_orgs, org_groups, projects, orgs, users RESTART IDENTITY CASCADE');

  const { rows: [alpha] } = await db.query<{ id: number }>(
    "INSERT INTO orgs (slug, name) VALUES ('alpha', 'Alpha') RETURNING id",
  );
  const { rows: [beta] } = await db.query<{ id: number }>(
    "INSERT INTO orgs (slug, name) VALUES ('beta', 'Beta') RETURNING id",
  );
  await db.query(
    "INSERT INTO org_groups (org_id, ldap_group) VALUES ($1, 'alpha-team'), ($1, 'shared'), ($2, 'beta-team'), ($2, 'shared')",
    [alpha.id, beta.id],
  );
  const { rows: [alphaProject] } = await db.query<{ id: number }>(
    "INSERT INTO projects (name, org_id) VALUES ('Alpha project', $1) RETURNING id", [alpha.id],
  );
  const { rows: [betaProject] } = await db.query<{ id: number }>(
    "INSERT INTO projects (name, org_id) VALUES ('Beta project', $1) RETURNING id", [beta.id],
  );
  await db.query(
    "INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, 'alpha-team'), ($1, 'shared'), ($2, 'beta-team'), ($2, 'shared')",
    [alphaProject.id, betaProject.id],
  );
  await db.query(
    `INSERT INTO users (username, first_name, last_name, email, ldap_groups) VALUES
       ('alpha-admin', 'Alpha', 'Admin', 'alpha-admin@example.test', ARRAY['alpha-team']),
       ('beta-admin', 'Beta', 'Admin', 'beta-admin@example.test', ARRAY['beta-team']),
       ('alpha-lead', 'Alpha', 'Lead', 'alpha-lead@example.test', ARRAY['alpha-team']),
       ('alpha-member', 'Alpha', 'Member', 'alpha-member@example.test', ARRAY['alpha-team', 'shared']),
       ('beta-member', 'Beta', 'Member', 'beta-member@example.test', ARRAY['beta-team', 'shared']),
       ('local-admin', 'Local', 'Admin', 'local-admin@example.test', ARRAY[]::text[]),
       ('missing-org-row', 'Missing', 'Membership', 'missing@example.test', ARRAY['alpha-team'])`,
  );
  await db.query(
    `INSERT INTO user_orgs (username, org_id, role) VALUES
       ('alpha-admin', $1, 'org_admin'), ('alpha-lead', $1, 'project_lead'),
       ('alpha-member', $1, 'member'), ('beta-admin', $2, 'org_admin'),
       ('beta-member', $2, 'member')`,
    [alpha.id, beta.id],
  );

  fixture = { alphaId: alpha.id, betaId: beta.id, alphaProjectId: alphaProject.id, betaProjectId: betaProject.id };
  for (const user of users.values()) {
    if (!user.orgs[0]) continue;
    user.orgs[0].orgId = user.orgs[0].orgSlug === 'alpha' ? alpha.id : beta.id;
  }

  const app = createApp({
    testUserFromRequest: (req) => users.get(req.header('x-test-user') ?? ''),
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await db.end();
});

test('a project lead sees only projects in their active organisation', async () => {
  const response = await request('/orgs/alpha/v2/projects', 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Alpha project/);
  assert.doesNotMatch(body, /Beta project/);
});

test('the React project workspace preserves project-lead organisation scoping', async () => {
  const response = await request('/orgs/alpha/v2/projects', 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Roster workspace/);
  assert.match(body, /Alpha project/);
  assert.doesNotMatch(body, /Beta project/);
});

test('the local preview proxy may use a different loopback port without bypassing production CSRF checks', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-admin', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:3300', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=',
  });
  // The invalid project name reaches the action (400); it is not rejected as cross-site.
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Cross-site form submission rejected/);
});

test('production V2 mutations compare against the configured public roster origin', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRosterHost = process.env.ROSTER_HOST;
  process.env.NODE_ENV = 'production';
  process.env.ROSTER_HOST = 'roster.example.test';
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-admin', {
      method: 'POST',
      headers: { Origin: 'https://roster.example.test', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=',
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /Cross-site form submission rejected/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalRosterHost === undefined) delete process.env.ROSTER_HOST;
    else process.env.ROSTER_HOST = originalRosterHost;
  }
});

test('V2 accepts a same-origin browser navigation when privacy settings omit Origin and Referer', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-admin', {
    method: 'POST',
    headers: { Origin: '', 'Sec-Fetch-Site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=',
  });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /Cross-site form submission rejected/);
});

test('V2 rejects an origin-less cross-site browser navigation', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-admin', {
    method: 'POST',
    headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=',
  });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Cross-site form submission rejected/);
});

test('the organization root enters the shared React dashboard with role-gated destinations', async () => {
  const root = await request('/orgs/alpha', 'alpha-member');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/orgs/alpha/v2/dashboard');

  const member = await request('/orgs/alpha/v2/dashboard', 'alpha-member');
  assert.equal(member.status, 200);
  const memberBody = await member.text();
  assert.match(memberBody, /My account/);
  assert.doesNotMatch(memberBody, /Open projects/);
  assert.doesNotMatch(memberBody, /Open people/);
  assert.doesNotMatch(memberBody, /Open settings/);

  const lead = await request('/orgs/alpha/v2/dashboard', 'alpha-lead');
  assert.equal(lead.status, 200);
  const leadBody = await lead.text();
  assert.match(leadBody, /Open projects/);
  assert.match(leadBody, /Open people/);
  assert.doesNotMatch(leadBody, /Open settings/);
});

test('retired legacy workspace URLs bridge to React and legacy mutations are unreachable', async () => {
  const cases: Array<[string, string, string]> = [
    ['/orgs/alpha/dashboard', 'alpha-admin', '/orgs/alpha/v2/dashboard'],
    ['/orgs/alpha/admin/users/add?q=alpha', 'alpha-admin', '/orgs/alpha/v2/people/add?q=alpha'],
    ['/orgs/alpha/admin/projects/1', 'alpha-admin', '/orgs/alpha/v2/projects/1'],
    ['/orgs/alpha/pl/projects/1/users/alpha-member/edit', 'alpha-lead', '/orgs/alpha/v2/projects/1/members/alpha-member/edit'],
    ['/system/users', 'local-admin', '/system/v2/users'],
    ['/system/orgs/1/ldap-mappings', 'local-admin', '/system/v2/organizations/1/mappings'],
  ];
  for (const [path, username, destination] of cases) {
    const response = await request(path, username);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), destination, path);
  }
  const retiredWrite = await request('/orgs/alpha/admin/users/sync', 'alpha-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(retiredWrite.status, 410);
});

test('the organization selector shows only the authenticated member workspaces', async () => {
  const member = await request('/orgs', 'alpha-admin');
  assert.equal(member.status, 200);
  const body = await member.text();
  assert.match(body, /Select organization/);
  assert.match(body, /href="\/orgs\/alpha\/v2\/dashboard"/);
  assert.doesNotMatch(body, /href="\/orgs\/beta\/v2\/dashboard"/);
  assert.match(body, /org admin/);

  const local = await request('/orgs', 'local-admin');
  assert.equal(local.status, 200);
  const localBody = await local.text();
  assert.match(localBody, /href="\/orgs\/alpha\/v2\/dashboard"/);
  assert.match(localBody, /href="\/orgs\/beta\/v2\/dashboard"/);
  assert.match(localBody, /System administration/);
});

test('the React system local-admin workspace preserves create, toggle, and confirmed deletion', async () => {
  const root = await request('/system', 'local-admin');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/system/v2/local-admins');

  const page = await request('/system/v2/local-admins', 'local-admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Create local admin/);
  await db.query("UPDATE local_admins SET last_used_at = NOW() WHERE username = 'local-admin'");
  const recentlyUsed = await request('/system/v2/local-admins', 'local-admin');
  assert.equal(recentlyUsed.status, 200);
  assert.match(await recentlyUsed.text(), /local-admin/);

  const created = await request('/system/v2/local-admins', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=create&username=recovery-admin&password=test-password',
  });
  assert.equal(created.status, 302);
  const { rows: [admin] } = await db.query<{ id: number; enabled: boolean }>(
    "SELECT id, enabled FROM local_admins WHERE username = 'recovery-admin'",
  );
  assert.equal(admin.enabled, true);

  const toggled = await request('/system/v2/local-admins', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=toggle&id=${admin.id}`,
  });
  assert.equal(toggled.status, 302);
  const { rows: [disabled] } = await db.query<{ enabled: boolean }>('SELECT enabled FROM local_admins WHERE id = $1', [admin.id]);
  assert.equal(disabled.enabled, false);

  const rejected = await request('/system/v2/local-admins', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=delete&id=${admin.id}`,
  });
  assert.equal(rejected.status, 400);
  const removed = await request('/system/v2/local-admins', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=delete&id=${admin.id}&confirm=delete`,
  });
  assert.equal(removed.status, 302);
  const { rows } = await db.query('SELECT id FROM local_admins WHERE id = $1', [admin.id]);
  assert.equal(rows.length, 0);
});

test('the React system organization workspace preserves create, theme, and confirmed deletion', async () => {
  const page = await request('/system/v2/organizations', 'local-admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Create organization/);

  const created = await request('/system/v2/organizations', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=create&name=Temporary+System+Org&slug=temp-system&description=Test+workspace&themeColor=%23123456',
  });
  assert.equal(created.status, 302);
  const { rows: [organization] } = await db.query<{ id: number; theme_color: string }>(
    "SELECT id, theme_color FROM orgs WHERE slug = 'temp-system'",
  );
  assert.deepEqual(organization.theme_color, '#123456');

  const themed = await request('/system/v2/organizations', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=theme&id=${organization.id}&themeColor=%23654321`,
  });
  assert.equal(themed.status, 302);
  const { rows: [changed] } = await db.query<{ theme_color: string }>('SELECT theme_color FROM orgs WHERE id = $1', [organization.id]);
  assert.equal(changed.theme_color, '#654321');

  const rejected = await request('/system/v2/organizations', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=delete&id=${organization.id}`,
  });
  assert.equal(rejected.status, 400);
  const removed = await request('/system/v2/organizations', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=delete&id=${organization.id}&confirm=delete`,
  });
  assert.equal(removed.status, 302);
  const { rows } = await db.query('SELECT id FROM orgs WHERE id = $1', [organization.id]);
  assert.equal(rows.length, 0);
});

test('the React system LDAP mapping workspace scopes mappings and assigns the highest role on sync', async () => {
  const { rows: [organization] } = await db.query<{ id: number }>(
    "INSERT INTO orgs (slug, name) VALUES ('mapping-test', 'Mapping test') RETURNING id",
  );
  try {
    const page = await request(`/system/v2/organizations/${organization.id}/mappings`, 'local-admin');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mapping test.*LDAP mappings/);

    for (const [group, role] of [['beta-team', 'member'], ['shared', 'project_lead']] as const) {
      const added = await request(`/system/v2/organizations/${organization.id}/mappings`, 'local-admin', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `intent=add&ldapGroup=${group}&role=${role}`,
      });
      assert.equal(added.status, 302);
    }
    const sync = await request(`/system/v2/organizations/${organization.id}/mappings`, 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=sync',
    });
    assert.equal(sync.status, 302);
    assert.match(sync.headers.get('location') ?? '', new RegExp(`^/system/v2/organizations/${organization.id}/mappings\\?synced=\\d+$`));
    const { rows: roles } = await db.query<{ role: string }>('SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', ['beta-member', organization.id]);
    assert.deepEqual(roles, [{ role: 'project_lead' }]);

    const { rows: [mapping] } = await db.query<{ id: number }>(
      "SELECT id FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = 'beta-team'", [organization.id],
    );
    const changed = await request(`/system/v2/organizations/${organization.id}/mappings`, 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=role&mappingId=${mapping.id}&role=org_admin`,
    });
    assert.equal(changed.status, 302);
    const resync = await request(`/system/v2/organizations/${organization.id}/mappings`, 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=sync',
    });
    assert.equal(resync.status, 302);
    const { rows: updatedRoles } = await db.query<{ role: string }>('SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', ['beta-member', organization.id]);
    assert.deepEqual(updatedRoles, [{ role: 'org_admin' }]);
  } finally {
    await db.query('DELETE FROM audit_log WHERE org_id = $1', [organization.id]);
    await db.query('DELETE FROM orgs WHERE id = $1', [organization.id]);
  }
});

test('the React system audit workspace filters and exposes structured event details', async () => {
  await db.query(
    "INSERT INTO audit_log (actor, action, target_username, details, org_id) VALUES ('local-admin', 'test_event', 'alpha-member', $1, $2)",
    [JSON.stringify({ source: 'integration-test' }), fixture.alphaId],
  );
  const page = await request('/system/v2/audit?days=1', 'local-admin');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /test event/);
  assert.match(body, /integration-test/);
  assert.match(body, /href="\/orgs\/alpha\/v2\/dashboard"/);
});

test('the React system user directory is cross-organization and links to the React edit workflow', async () => {
  const page = await request('/system/v2/users', 'local-admin');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Alpha Member/);
  assert.match(body, /Beta Member/);
  assert.match(body, /href="\/system\/v2\/users\/alpha-member\/edit"/);
  assert.match(body, /Create directory user/);
});

test('the React system and organization directories retain guarded LDAP sync controls', async () => {
  ldap.setLdapTestOverrides({ listUsers: async () => [] });
  try {
    const systemSync = await request('/system/v2/users', 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=sync',
    });
    assert.equal(systemSync.status, 302);
    assert.equal(systemSync.headers.get('location'), '/system/v2/users?sync=0,0,0');

    const orgSync = await request('/orgs/alpha/v2/people', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=sync',
    });
    assert.equal(orgSync.status, 302);
    assert.equal(orgSync.headers.get('location'), '/orgs/alpha/v2/people?sync=0,0,0');

    const denied = await request('/orgs/alpha/v2/people', 'alpha-lead', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=sync',
    });
    assert.equal(denied.status, 403);
  } finally {
    ldap.setLdapTestOverrides(undefined);
  }
});

test('the React system directory-user workflow provisions through a session result and edits all directory fields', async () => {
  const username = ldap.generateUsername('System', 'Created', 'system.created@example.test');
  ldap.setLdapTestOverrides({
    listGroups: async () => ['alpha-team', 'shared'],
    createUser: async () => ({ status: 'success', message: 'created', tempPassword: 'one-time-password' }),
    updateUserProfile: async () => ({ status: 'success', message: 'profile updated' }),
    updateUserGroups: async () => ({ status: 'success', message: 'groups updated' }),
    updateUserExpiry: async () => ({ status: 'success', message: 'expiry updated' }),
    setSshKeys: async () => ({ status: 'success', message: 'keys updated' }),
  });
  try {
    const create = await request('/system/v2/users/new', 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'firstName=System&lastName=Created&email=system.created%40example.test&role=staff&expiryDate=2030-01-01&ldapGroups=alpha-team',
    });
    assert.equal(create.status, 302);
    assert.equal(create.headers.get('location'), '/system/v2/users/new/result');
    const cookie = create.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const result = await request('/system/v2/users/new/result', 'local-admin', { headers: { cookie } });
    assert.equal(result.status, 200);
    const resultBody = await result.text();
    assert.match(resultBody, /one-time-password/);
    assert.match(resultBody, /displayed once/);
    const repeated = await request('/system/v2/users/new/result', 'local-admin', { headers: { cookie } });
    assert.equal(repeated.status, 404);

    const edit = await request(`/system/v2/users/${username}/edit`, 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'firstName=System&lastName=Updated&email=system.updated%40example.test&role=researcher&expiryDate=2031-02-03&groups=shared&slackUsername=system-slack&secondaryEmail=personal%40example.test&phone=555&sshKeys=',
    });
    assert.equal(edit.status, 302);
    assert.equal(edit.headers.get('location'), '/system/v2/users');
    const { rows } = await db.query<{ last_name: string; email: string; ldap_groups: string[]; role: string }>('SELECT last_name, email, ldap_groups, role FROM users WHERE username = $1', [username]);
    assert.deepEqual(rows, [{ last_name: 'Updated', email: 'system.updated@example.test', ldap_groups: ['shared'], role: 'researcher' }]);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM users WHERE username = $1', [username]);
  }
});

test('the React system group workflow provisions LDAP and automatically makes a project group available to its organization', async () => {
  const groupName = 'system-test-group';
  ldap.setLdapTestOverrides({ createGroup: async () => ({ status: 'success', message: 'group created' }) });
  try {
    const page = await request('/system/v2/groups/new', 'local-admin');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Create directory group/);
    const created = await request('/system/v2/groups/new', 'local-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `groupName=${groupName}&projectId=${fixture.alphaProjectId}`,
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), `/system/v2/groups/new?created=${groupName}`);
    const { rows: orgGroups } = await db.query('SELECT ldap_group FROM org_groups WHERE org_id = $1 AND ldap_group = $2', [fixture.alphaId, groupName]);
    const { rows: projectGroups } = await db.query('SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = $2', [fixture.alphaProjectId, groupName]);
    assert.equal(orgGroups.length, 1);
    assert.equal(projectGroups.length, 1);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM project_ldap_groups WHERE ldap_group = $1', [groupName]);
    await db.query('DELETE FROM org_groups WHERE ldap_group = $1', [groupName]);
  }
});

test('the React people workspace is scoped to the active organisation', async () => {
  const response = await request('/orgs/alpha/v2/people', 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Alpha Member/);
  assert.doesNotMatch(body, /Beta Member/);
  assert.match(body, /Only people with an organization membership appear here/);
});

test('People and System Users expose expiry dates and server-side sortable headers', async () => {
  await db.query("UPDATE users SET expiry_date = CASE username WHEN 'alpha-admin' THEN '2031-01-01'::date WHEN 'alpha-member' THEN '2029-01-01'::date ELSE expiry_date END");
  try {
    const people = await request('/orgs/alpha/v2/people?sort=expiry&dir=asc', 'alpha-admin');
    assert.equal(people.status, 200);
    const peopleBody = await people.text();
    assert.match(peopleBody, /href="\/orgs\/alpha\/v2\/people\?sort=expiry&amp;dir=desc"/);
    assert.match(peopleBody, />Expiry</);
    assert.match(peopleBody, /2031-01-01/);
    assert.ok(peopleBody.indexOf('2029-01-01') < peopleBody.indexOf('2031-01-01'));

    const system = await request('/system/v2/users?sort=expiry&dir=asc', 'local-admin');
    assert.equal(system.status, 200);
    const systemBody = await system.text();
    assert.match(systemBody, /2031-01-01/);
    assert.ok(systemBody.indexOf('2029-01-01') < systemBody.indexOf('2031-01-01'));
  } finally {
    await db.query("UPDATE users SET expiry_date = NULL WHERE username IN ('alpha-admin', 'alpha-member')");
  }
});

test('the React add-person search ranks directory matches and shows membership status', async () => {
  const response = await request('/orgs/alpha/v2/people/add?q=member', 'alpha-admin');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Alpha Member/);
  assert.match(body, /Beta Member/);
  assert.match(body, /<form method="post">/);
  assert.match(body, /Current role: member/);
  assert.match(body, /Not in this organization/);
});

test('the React add-person search requires an organisation admin', async () => {
  const response = await request('/orgs/alpha/v2/people/add?q=member', 'alpha-lead');
  assert.equal(response.status, 403);
});

test('the React project add-person search reuses ranked directory results for a project lead', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/add?q=member`, 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Alpha Member/);
  assert.match(body, /Beta Member/);
  assert.match(body, /<form class="project-member-form" method="post">/);
  assert.match(body, /name="groups" value="alpha-team"/);
});

test('the React organization person-create page is admin-only and posts to its workspace action', async () => {
  const denied = await request('/orgs/alpha/v2/people/new', 'alpha-lead');
  assert.equal(denied.status, 403);

  const allowed = await request('/orgs/alpha/v2/people/new', 'alpha-admin');
  assert.equal(allowed.status, 200);
  const body = await allowed.text();
  assert.match(body, /<form class="workspace-form" method="post">/);
  assert.match(body, /name="ldapGroups" value="alpha-team"/);
});

test('organization-admin provisioning creates the LDAP account and immediate organization membership', async () => {
  const username = ldap.generateUsername('New', 'Admin', 'new.admin@example.test');
  ldap.setLdapTestOverrides({ createUser: async () => ({ status: 'success', message: 'created', tempPassword: 'test-password' }) });
  try {
    const response = await request('/orgs/alpha/v2/people/new', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'firstName=New&lastName=Admin&email=new.admin%40example.test&role=student&expiryDate=2030-01-01&ldapGroups=alpha-team',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/orgs/alpha/v2/people/new/result');
    const { rows } = await db.query<{ role: string }>('SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', [username, fixture.alphaId]);
    assert.deepEqual(rows, [{ role: 'member' }]);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM users WHERE username = $1', [username]);
  }
});

test('the React organization create action uses a one-time session result and immediate membership', async () => {
  const username = ldap.generateUsername('React', 'Org', 'react.org@example.test');
  ldap.setLdapTestOverrides({ createUser: async () => ({ status: 'success', message: 'created', tempPassword: 'one-time-org-password' }) });
  try {
    const create = await request('/orgs/alpha/v2/people/new', 'alpha-admin', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'firstName=React&lastName=Org&email=react.org%40example.test&role=student&expiryDate=2030-01-01&ldapGroups=alpha-team' });
    assert.equal(create.status, 302); assert.equal(create.headers.get('location'), '/orgs/alpha/v2/people/new/result');
    const cookie = create.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const result = await request('/orgs/alpha/v2/people/new/result', 'alpha-admin', { headers: { cookie } });
    assert.match(await result.text(), /one-time-org-password/);
    const { rows } = await db.query<{ role: string }>('SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', [username, fixture.alphaId]);
    assert.deepEqual(rows, [{ role: 'member' }]);
  } finally { ldap.setLdapTestOverrides(undefined); await db.query('DELETE FROM users WHERE username = $1', [username]); }
});

test('the React organization person-edit page is scoped and posts back to the workspace action', async () => {
  const allowed = await request('/orgs/alpha/v2/people/alpha-member/edit', 'alpha-admin');
  assert.equal(allowed.status, 200);
  const body = await allowed.text();
  assert.match(body, /<form class="workspace-form" method="post">/);
  assert.match(body, /name="groups" checked="" value="alpha-team"/);

  const crossOrg = await request('/orgs/alpha/v2/people/beta-member/edit', 'alpha-admin');
  assert.equal(crossOrg.status, 404);

  const denied = await request('/orgs/alpha/v2/people/alpha-member/edit', 'alpha-lead');
  assert.equal(denied.status, 403);
});

test('the React organization person editor saves through its scoped action and returns to People', async () => {
  const calls: string[] = [];
  ldap.setLdapTestOverrides({
    updateUserProfile: async () => { calls.push('profile'); return { status: 'success', message: 'updated' }; },
    updateUserGroups: async () => { calls.push('groups'); return { status: 'success', message: 'updated' }; },
    updateUserExpiry: async () => { calls.push('expiry'); return { status: 'success', message: 'updated' }; },
    setSshKeys: async () => { calls.push('ssh'); return { status: 'success', message: 'updated' }; },
  });
  try {
    const response = await request('/orgs/alpha/v2/people/alpha-member/edit', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'firstName=Edited&lastName=Member&email=edited.member%40example.test&role=staff&expiryDate=2030-01-01&groups=alpha-team&githubUsername=&slackUsername=edited-slack&secondaryEmail=personal%40example.test&phone=%2B1+555+0188&sshKeys=',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/orgs/alpha/v2/people');
    assert.deepEqual(calls.sort(), ['expiry', 'groups', 'profile', 'ssh']);
    const { rows: [person] } = await db.query<{ first_name: string; role: string; ldap_groups: string[]; github_username: string | null }>(
      "SELECT first_name, role, ldap_groups, github_username FROM users WHERE username = 'alpha-member'",
    );
    assert.deepEqual(person, { first_name: 'Edited', role: 'staff', ldap_groups: ['alpha-team'], github_username: null });
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query(`UPDATE users SET first_name = 'Alpha', last_name = 'Member', email = 'alpha-member@example.test',
      role = NULL, expiry_date = NULL, ldap_groups = ARRAY['alpha-team', 'shared'], github_username = NULL,
      slack_username = NULL, secondary_email = NULL, phone = NULL WHERE username = 'alpha-member'`);
  }
});

test('the React project person-create page preserves project-lead access and group scope', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new`, 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<form class="workspace-form" method="post">/);
  assert.match(body, /Project-created accounts are students and expire after 90 days/);
  assert.match(body, /name="ldapGroups" checked="" value="alpha-team"/);
  assert.doesNotMatch(body, /beta-team/);
});

test('project-lead provisioning creates an immediate organization member with project-scoped groups', async () => {
  const username = ldap.generateUsername('New', 'Project', 'new.project@example.test');
  ldap.setLdapTestOverrides({ createUser: async () => ({ status: 'success', message: 'created', tempPassword: 'test-password' }) });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new`, 'alpha-lead', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'firstName=New&lastName=Project&email=new.project%40example.test&ldapGroups=alpha-team',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new/result`);
    const { rows } = await db.query<{ role: string; ldap_groups: string[] }>(
      `SELECT uo.role, u.ldap_groups FROM user_orgs uo JOIN users u ON u.username = uo.username
       WHERE uo.username = $1 AND uo.org_id = $2`, [username, fixture.alphaId],
    );
    assert.deepEqual(rows, [{ role: 'member', ldap_groups: ['alpha-team'] }]);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM users WHERE username = $1', [username]);
  }
});

test('the React project create action enforces project groups and uses a one-time session result', async () => {
  const username = ldap.generateUsername('React', 'Project', 'react.project@example.test');
  ldap.setLdapTestOverrides({ createUser: async () => ({ status: 'success', message: 'created', tempPassword: 'one-time-project-password' }) });
  try {
    const create = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new`, 'alpha-lead', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'firstName=React&lastName=Project&email=react.project%40example.test&ldapGroups=alpha-team' });
    assert.equal(create.status, 302); assert.equal(create.headers.get('location'), `/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new/result`);
    const cookie = create.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const result = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/new/result`, 'alpha-lead', { headers: { cookie } });
    assert.match(await result.text(), /one-time-project-password/);
    const { rows } = await db.query<{ role: string; ldap_groups: string[] }>('SELECT uo.role, u.ldap_groups FROM user_orgs uo JOIN users u ON u.username = uo.username WHERE uo.username = $1 AND uo.org_id = $2', [username, fixture.alphaId]);
    assert.deepEqual(rows, [{ role: 'member', ldap_groups: ['alpha-team'] }]);
  } finally { ldap.setLdapTestOverrides(undefined); await db.query('DELETE FROM users WHERE username = $1', [username]); }
});

test('project-lead add-existing flow makes a project user immediately visible in the organization roster', async () => {
  let update: { username: string; groups: string[] } | undefined;
  ldap.setLdapTestOverrides({ updateUserGroups: async (username, groups) => {
    update = { username, groups };
    return { status: 'success', message: 'updated' };
  } });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/add?q=missing-org-row`, 'alpha-lead', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=missing-org-row&groups=alpha-team',
    });
    assert.equal(response.status, 302);
    assert.deepEqual(update, { username: 'missing-org-row', groups: ['alpha-team'] });
    const { rows } = await db.query<{ role: string }>('SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', ['missing-org-row', fixture.alphaId]);
    assert.deepEqual(rows, [{ role: 'member' }]);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM user_orgs WHERE username = $1 AND org_id = $2', ['missing-org-row', fixture.alphaId]);
  }
});

test('the React project member-edit page remains project-scoped for a lead', async () => {
  const allowed = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/alpha-member/edit`, 'alpha-lead');
  assert.equal(allowed.status, 200);
  const body = await allowed.text();
  assert.match(body, /<form class="workspace-form" method="post">/);
  assert.match(body, /name="groups" checked="" value="alpha-team"/);

  const denied = await request(`/orgs/beta/v2/projects/${fixture.betaProjectId}/members/alpha-member/edit`, 'beta-admin');
  assert.equal(denied.status, 404);
});

test('the React project member editor saves only the eligible project member and returns to its project', async () => {
  const calls: string[] = [];
  ldap.setLdapTestOverrides({
    updateUserGroups: async () => { calls.push('groups'); return { status: 'success', message: 'updated' }; },
    setSshKeys: async () => { calls.push('ssh'); return { status: 'success', message: 'updated' }; },
  });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/alpha-member/edit`, 'alpha-lead', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'groups=alpha-team&githubUsername=&slackUsername=project-slack&secondaryEmail=member.personal%40example.test&phone=%2B1+555+0177&disabled=true&sshKeys=',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/orgs/alpha/v2/projects/${fixture.alphaProjectId}`);
    assert.deepEqual(calls.sort(), ['groups', 'ssh']);
    const { rows: [member] } = await db.query<{ ldap_groups: string[]; disabled: boolean; slack_username: string }>(
      "SELECT ldap_groups, disabled, slack_username FROM users WHERE username = 'alpha-member'",
    );
    assert.deepEqual(member, { ldap_groups: ['alpha-team'], disabled: true, slack_username: 'project-slack' });
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query("UPDATE users SET ldap_groups = ARRAY['alpha-team', 'shared'], disabled = FALSE, github_username = NULL, slack_username = NULL, secondary_email = NULL, phone = NULL WHERE username = 'alpha-member'");
  }
});

test('the React settings workspace requires an organisation admin', async () => {
  const denied = await request('/orgs/alpha/v2/settings', 'alpha-lead');
  assert.equal(denied.status, 403);

  const allowed = await request('/orgs/alpha/v2/settings', 'alpha-admin');
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /Save GitHub settings/);
});

test('the React settings action writes only the active organisation integration', async () => {
  const response = await request('/orgs/alpha/v2/settings', 'alpha-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=slack&enabled=true&teamId=alpha-workspace&botToken=',
  });
  assert.equal(response.status, 302);
  const { rows } = await db.query<{ org_id: number; enabled: boolean; config: { teamId: string } }>(
    "SELECT org_id, enabled, config FROM org_integrations WHERE org_id = $1 AND service = 'slack'", [fixture.alphaId],
  );
  assert.deepEqual(rows, [{ org_id: fixture.alphaId, enabled: true, config: { teamId: 'alpha-workspace' } }]);
});

test('React workspace mutations reject a cross-site origin before changing roster data', async () => {
  const response = await request('/orgs/alpha/v2/settings/groups?group=alpha-team', 'alpha-admin', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=role&ldapGroup=alpha-team&role=org_admin',
  });
  assert.equal(response.status, 403);
  const { rows } = await db.query('SELECT role FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2', [fixture.alphaId, 'alpha-team']);
  assert.equal(rows.length, 0);
});

test('the React group-mapping settings page writes role and integration targets only for its organization', async () => {
  const page = await request('/orgs/alpha/v2/settings/groups?group=alpha-team', 'alpha-admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /alpha-team[\s\S]*role/);
  const role = await request('/orgs/alpha/v2/settings/groups?group=alpha-team', 'alpha-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=role&ldapGroup=alpha-team&role=project_lead',
  });
  assert.equal(role.status, 302);
  const mapping = await request('/orgs/alpha/v2/settings/groups?group=alpha-team', 'alpha-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'intent=add&ldapGroup=alpha-team&service=github&targetId=alpha-target&targetName=Alpha+target',
  });
  assert.equal(mapping.status, 302);
  const { rows: roles } = await db.query<{ org_id: number; role: string }>('SELECT org_id, role FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2', [fixture.alphaId, 'alpha-team']);
  const { rows: targets } = await db.query<{ org_id: number; target_id: string }>('SELECT org_id, target_id FROM group_mappings WHERE org_id = $1 AND ldap_group = $2 AND target_id = $3', [fixture.alphaId, 'alpha-team', 'alpha-target']);
  assert.deepEqual(roles, [{ org_id: fixture.alphaId, role: 'project_lead' }]);
  assert.deepEqual(targets, [{ org_id: fixture.alphaId, target_id: 'alpha-target' }]);
  await db.query('DELETE FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2', [fixture.alphaId, 'alpha-team']);
  await db.query('DELETE FROM group_mappings WHERE org_id = $1 AND target_id = $2', [fixture.alphaId, 'alpha-target']);
});

test('the React group-mapping workspace creates organization and project groups without crossing organization boundaries', async () => {
  const groupName = 'alpha-react-settings-group';
  ldap.setLdapTestOverrides({ createGroup: async () => ({ status: 'success', message: 'created' }) });
  try {
    const created = await request('/orgs/alpha/v2/settings/groups', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `intent=create&groupName=${groupName}&projectId=${fixture.alphaProjectId}`,
    });
    assert.equal(created.status, 302);
    assert.equal(created.headers.get('location'), `/orgs/alpha/v2/settings/groups?group=${groupName}`);
    const { rows: groups } = await db.query<{ org_id: number; ldap_group: string }>('SELECT org_id, ldap_group FROM org_groups WHERE ldap_group = $1', [groupName]);
    const { rows: projectGroups } = await db.query<{ project_id: number }>('SELECT project_id FROM project_ldap_groups WHERE ldap_group = $1', [groupName]);
    assert.deepEqual(groups, [{ org_id: fixture.alphaId, ldap_group: groupName }]);
    assert.deepEqual(projectGroups, [{ project_id: fixture.alphaProjectId }]);

    const rejected = await request('/orgs/alpha/v2/settings/groups', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `intent=create&groupName=forged-group&projectId=${fixture.betaProjectId}`,
    });
    assert.equal(rejected.status, 400);
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query('DELETE FROM project_ldap_groups WHERE ldap_group = $1', [groupName]);
    await db.query('DELETE FROM org_groups WHERE ldap_group = $1', [groupName]);
  }
});

test('the React account workspace renders and updates the signed-in local admin without LDAP', async () => {
  const page = await request('/orgs/alpha/v2/account', 'local-admin');
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /My account/);
  assert.match(body, /Local Admin/);
  assert.doesNotMatch(body, /SSH public keys/);

  const response = await request('/orgs/alpha/v2/account', 'local-admin', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'secondaryEmail=personal%40example.test&phone=%2B1+555+0100&sshKeys=ignored',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/orgs/alpha/v2/account?saved=1');
  const { rows } = await db.query<{ secondary_email: string; phone: string }>(
    "SELECT secondary_email, phone FROM users WHERE username = 'local-admin'",
  );
  assert.deepEqual(rows, [{ secondary_email: 'personal@example.test', phone: '+1 555 0100' }]);
});

test('the React account workspace updates the signed-in directory user and writes their SSH keys', async () => {
  let received: { username: string; keys: string[] } | undefined;
  ldap.setLdapTestOverrides({ setSshKeys: async (username, keys) => {
    received = { username, keys };
    return { status: 'success', message: 'updated' };
  } });
  try {
    const response = await request('/orgs/alpha/v2/account', 'alpha-member', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'secondaryEmail=member.personal%40example.test&phone=%2B1+555+0199&sshKeys=ssh-ed25519+AAAAfirst%0Assh-ed25519+AAAAsecond',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/orgs/alpha/v2/account?saved=1');
    assert.deepEqual(received, { username: 'alpha-member', keys: ['ssh-ed25519 AAAAfirst', 'ssh-ed25519 AAAAsecond'] });
    const { rows: [user] } = await db.query<{ secondary_email: string; phone: string }>(
      "SELECT secondary_email, phone FROM users WHERE username = 'alpha-member'",
    );
    assert.deepEqual(user, { secondary_email: 'member.personal@example.test', phone: '+1 555 0199' });
  } finally {
    ldap.setLdapTestOverrides(undefined);
    await db.query("UPDATE users SET secondary_email = NULL, phone = NULL WHERE username = 'alpha-member'");
  }
});

test('the React project workspace retains per-user audit-log links', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /\/projects\/1\/members\/alpha-admin\/audit/);
  assert.match(body, />Log<\/a>/);
  assert.match(body, /class="person-link" href="\/orgs\/alpha\/v2\/projects\/1\/members\/alpha-admin\/edit"/);
});

test('the React project audit page rejects a member outside the active organisation', async () => {
  const response = await request(`/orgs/beta/v2/projects/${fixture.betaProjectId}/members/alpha-member/audit`, 'beta-admin');
  assert.equal(response.status, 404);
});

test('the React project loader rejects a project from another organisation', async () => {
  const response = await request(`/orgs/beta/v2/projects/${fixture.alphaProjectId}`, 'beta-admin');
  const body = await response.text();
  assert.equal(response.status, 404, body);
  assert.match(body, /Project not found/);
});

test('the React project action updates only an admin’s active organisation', async () => {
  const denied = await request(`/orgs/beta/v2/projects/${fixture.alphaProjectId}`, 'beta-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Cross-org+rename&description=Must+not+write',
  });
  assert.equal(denied.status, 404, await denied.text());

  const allowed = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Alpha+project+updated&description=Updated+through+React+Router',
  });
  assert.equal(allowed.status, 302);
  assert.equal(allowed.headers.get('location'), `/orgs/alpha/v2/projects/${fixture.alphaProjectId}`);

  const { rows: [project] } = await db.query<{ name: string; description: string }>(
    'SELECT name, description FROM projects WHERE id = $1', [fixture.alphaProjectId],
  );
  assert.deepEqual(project, {
    name: 'Alpha project updated',
    description: 'Updated through React Router',
  });
  await db.query(
    "UPDATE projects SET name = 'Alpha project', description = NULL WHERE id = $1",
    [fixture.alphaProjectId],
  );
});

test('the React project settings workspace is admin-only and rejects foreign groups', async () => {
  const denied = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/settings`, 'alpha-lead');
  assert.equal(denied.status, 403);

  const page = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/settings`, 'alpha-admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Project groups/);

  const forged = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/settings`, 'alpha-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=add-group&ldapGroup=beta-team',
  });
  assert.equal(forged.status, 400);
});

test('the React project creation action creates only within the active organisation', async () => {
  const response = await request('/orgs/alpha/v2/projects/new', 'alpha-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Temporary+React+Project&description=Created+by+test',
  });
  assert.equal(response.status, 302);
  const location = response.headers.get('location') ?? '';
  assert.match(location, /^\/orgs\/alpha\/v2\/projects\/\d+\/settings$/);
  const projectId = Number(location.split('/')[5]);
  const { rows: [project] } = await db.query<{ org_id: number }>('SELECT org_id FROM projects WHERE id = $1', [projectId]);
  assert.deepEqual(project, { org_id: fixture.alphaId });
  await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
});

test('an admin cannot read a different organisation’s project by id', async () => {
  const response = await request(`/orgs/beta/v2/projects/${fixture.alphaProjectId}`, 'beta-admin');
  assert.equal(response.status, 404);
});

test('project lists exclude users that lack an organisation membership', async () => {
  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-lead');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /alpha-member/);
  assert.doesNotMatch(body, /missing-org-row/);
});

test('an org admin cannot edit a user outside that organisation roster', async () => {
  const response = await request('/orgs/alpha/v2/people/beta-member/edit', 'alpha-admin');
  assert.equal(response.status, 404);
});

test('an org admin cannot attach another organisation’s group to a project', async () => {
  const response = await request(`/orgs/beta/v2/projects/${fixture.betaProjectId}/settings`, 'beta-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'intent=add&ldapGroup=alpha-team',
  });
  assert.equal(response.status, 400);
});

test('organization integration mappings are read and removed only within the active organization', async () => {
  const { rows: [alphaMapping] } = await db.query<{ id: number }>(`INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id)
    VALUES ('shared', 'github', 'alpha-team', 'Alpha team', $1) RETURNING id`, [fixture.alphaId]);
  const { rows: [betaMapping] } = await db.query<{ id: number }>(`INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id)
    VALUES ('shared', 'github', 'beta-team', 'Beta team', $1) RETURNING id`, [fixture.betaId]);
  try {
    const alpha = await request('/orgs/alpha/v2/settings/groups?group=shared', 'alpha-admin');
    const alphaBody = await alpha.text();
    assert.match(alphaBody, /Alpha team/);
    assert.doesNotMatch(alphaBody, /Beta team/);
    const forged = await request('/orgs/alpha/v2/settings/groups?group=shared', 'alpha-admin', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `intent=delete&ldapGroup=shared&id=${betaMapping.id}`,
    });
    assert.equal(forged.status, 302);
    const { rows } = await db.query('SELECT id FROM group_mappings WHERE id = $1', [betaMapping.id]);
    assert.equal(rows.length, 1);
  } finally {
    await db.query('DELETE FROM group_mappings WHERE id = ANY($1::int[])', [[alphaMapping.id, betaMapping.id]]);
  }
});

test('forged project group submissions are rejected before LDAP is called', async () => {
  let ldapCalled = false;
  ldap.setLdapTestOverrides({ updateUserGroups: async () => {
    ldapCalled = true;
    throw new Error('LDAP must not be called for invalid input');
  } });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/add?q=missing-org-row`, 'alpha-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=missing-org-row&groups=beta-team',
    });
    assert.equal(response.status, 400);
    assert.equal(ldapCalled, false);
  } finally {
    ldap.setLdapTestOverrides(undefined);
  }
});

test('the membership writer makes a formerly missing project user visible in the org roster', async () => {
  await ensureUserOrgMembership('missing-org-row', fixture.alphaId);
  const { rows } = await db.query(
    'SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2',
    ['missing-org-row', fixture.alphaId],
  );
  assert.deepEqual(rows, [{ role: 'member' }]);

  const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}`, 'alpha-lead');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /missing-org-row/);
});

test('the React organization add action changes membership only in the active organization', async () => {
  const response = await request('/orgs/alpha/v2/people/add?q=beta-member', 'alpha-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'username=beta-member&role=project_lead',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/orgs/alpha/v2/people');
  const { rows } = await db.query<{ org_id: number; role: string }>(
    'SELECT org_id, role FROM user_orgs WHERE username = $1 ORDER BY org_id', ['beta-member'],
  );
  assert.deepEqual(rows, [
    { org_id: fixture.alphaId, role: 'project_lead' },
    { org_id: fixture.betaId, role: 'member' },
  ]);
  await db.query('DELETE FROM user_orgs WHERE username = $1 AND org_id = $2', ['beta-member', fixture.alphaId]);
});

test('the React project add action preserves non-project groups and repairs missing organization membership', async () => {
  let ldapGroups: string[] | undefined;
  ldap.setLdapTestOverrides({ updateUserGroups: async (_username, groups) => {
    ldapGroups = groups;
    return { status: 'success' };
  } });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/add?q=missing-org-row`, 'alpha-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=missing-org-row&groups=shared',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/orgs/alpha/v2/projects/${fixture.alphaProjectId}`);
    assert.deepEqual(ldapGroups, ['shared']);
    const { rows } = await db.query<{ role: string }>(
      'SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2', ['missing-org-row', fixture.alphaId],
    );
    assert.deepEqual(rows, [{ role: 'member' }]);
  } finally {
    ldap.setLdapTestOverrides(undefined);
  }
});

test('the React project add action rejects a forged group before LDAP is called', async () => {
  let ldapCalled = false;
  ldap.setLdapTestOverrides({ updateUserGroups: async () => {
    ldapCalled = true;
    return { status: 'success' };
  } });
  try {
    const response = await request(`/orgs/alpha/v2/projects/${fixture.alphaProjectId}/members/add`, 'alpha-lead', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=alpha-member&groups=beta-team',
    });
    assert.equal(response.status, 400);
    assert.equal(ldapCalled, false);
    assert.match(await response.text(), /Submitted groups do not belong to this project/);
  } finally {
    ldap.setLdapTestOverrides(undefined);
  }
});

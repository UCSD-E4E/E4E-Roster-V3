import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import { generateUsername } from '../../services/ldap';
import * as udm from '../../services/udm';
import { NewUser } from '../../services/types';

const router = Router();
router.use(requireAdmin);

// ── User list ─────────────────────────────────────────────────────
router.get('/', (_req: Request, res: Response) => {
  // TODO: query DB for roster once DB layer is added
  res.render('admin/users/index', { users: [] });
});

// ── New user wizard ───────────────────────────────────────────────

// Step 1: SSO form
router.get('/new', async (req: Request, res: Response) => {
  // Clear any stale wizard state from a previous attempt
  delete req.session.wizard;

  let groups: string[] = [];
  try {
    groups = await udm.listGroups();
  } catch (err) {
    console.error('[admin] Failed to fetch groups from UDM:', err);
  }

  res.render('admin/users/new/step1', { groups });
});

// Step 1 submit: create SSO account
router.post('/new/sso', async (req: Request, res: Response) => {
  const { firstName, lastName, email, role, expiryDate, ldapGroups } =
    req.body as Record<string, string | string[]>;

  const cleanEmail = (email as string).trim().toLowerCase();
  const cleanFirst = (firstName as string).trim();
  const cleanLast = (lastName as string).trim();

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: role as string,
    expiryDate: expiryDate as string,
    ldapGroups: [ldapGroups ?? []].flat(),
    githubTeams: [],
    serverGroups: [],
  };

  const result = await udm.createUser(user);

  req.session.wizard = {
    user,
    steps: { sso: result },
  };

  res.render('admin/users/new/step1-result', {
    user,
    result,
    nextUrl: '/admin/users/new/github-slack',
  });
});

// Step 2: GitHub + Slack (stub)
router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect('/admin/users/new');
  }
  res.render('admin/users/new/step2', { wizard: req.session.wizard });
});

// Step 3: Server access (stub)
router.get('/new/server', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect('/admin/users/new');
  }
  res.render('admin/users/new/step3', { wizard: req.session.wizard });
});

export default router;

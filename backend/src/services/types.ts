export type ProvisionStatus = 'success' | 'failed' | 'skipped' | 'already_exists';

export interface ProvisionResult {
  status: ProvisionStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface SystemStatus {
  exists: boolean;
  details?: Record<string, unknown>;
}

// Shape of a new user as entered by an admin
export interface NewUser {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  expiryDate: string;       // ISO date string: YYYY-MM-DD
  ldapGroups: string[];     // LDAP group CNs
  sshPublicKeys: string[];  // ed25519 public keys (OpenSSH-LPK)
  githubTeams: string[];    // GitHub team slugs
  serverGroups: string[];   // Server groups
}

// Wizard session state — accumulated as each step completes
export interface WizardState {
  user: NewUser;
  steps: {
    sso?: ProvisionResult & { tempPassword?: string };
    github?: ProvisionResult;
    slack?: ProvisionResult;
    server?: ProvisionResult;
  };
}

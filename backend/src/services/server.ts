import { NewUser, ProvisionResult, SystemStatus } from './types';

// TODO: implement via Python bridge (child_process → Ansible scripts in scripts/)
// Scripts: scripts/provision_server_account.py, scripts/check_server_account.py

export async function checkUser(_username: string): Promise<SystemStatus> {
  throw new Error('Server account service not yet implemented');
}

export async function provisionUser(_user: NewUser): Promise<ProvisionResult> {
  throw new Error('Server account service not yet implemented');
}

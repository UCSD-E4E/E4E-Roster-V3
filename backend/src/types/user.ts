export interface AuthUser {
  id: string;
  name: string;
  email: string;
  username: string;
  groups: string[];
  isAdmin: boolean;
  isProjectLead: boolean;
}

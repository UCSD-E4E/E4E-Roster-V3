import { AuthUser } from './user';

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

export {};

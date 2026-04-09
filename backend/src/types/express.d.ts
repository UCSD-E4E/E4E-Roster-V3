import { AuthUser } from './user';
import { WizardState } from '../services/types';

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

declare module 'express-session' {
  interface SessionData {
    wizard?: WizardState;
  }
}

export {};

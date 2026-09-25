import { ProfileScreen } from '../hud/profile-screen.js';
import type { AuthSession } from '../net/auth-session.js';

export interface ProfileMount {
  show(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function mountProfile(hudRoot: HTMLElement, session: AuthSession): ProfileMount {
  const screen = new ProfileScreen(hudRoot, session, { onClose: () => screen.hide() });
  return {
    show: () => screen.show(),
    isOpen: () => screen.isVisible(),
    dispose: () => screen.dispose(),
  };
}

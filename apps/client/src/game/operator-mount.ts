import { supabase } from '../net/supabase.js';
import { OperatorDashboard } from '../hud/operator-dashboard.js';
import { mountNotifications } from '../hud/notifications.js';

export function hasOperatorRole(): boolean {
  return supabase?.auth
    .getSession()
    .then(({ data }) => data.session?.user.app_metadata?.role === 'operator') as unknown as boolean;
}

export async function mountOperatorDashboard(host: HTMLElement): Promise<() => void> {
  if (!supabase) return () => undefined;
  const { data } = await supabase.auth.getSession();
  const allowed = data.session?.user.app_metadata?.role === 'operator';
  const enabled = import.meta.env.DEV || window.location.hash === '#operator';
  if (!allowed || !enabled) return () => undefined;
  const dashboard = new OperatorDashboard(host);
  await dashboard.load();
  const notificationRoot = document.createElement('div');
  host.append(notificationRoot);
  const notifications = mountNotifications(notificationRoot);
  return () => {
    notifications();
    host.replaceChildren();
  };
}

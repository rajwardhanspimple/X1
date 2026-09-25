import { supabase } from '../net/supabase.js';

export type PlayerNotification = { id: string; kind: string; reason: string; created_at: string; read_at: string | null };
export function mountNotifications(root: HTMLElement): () => void {
  let disposed = false;
  const render = (rows: PlayerNotification[]) => { if (disposed) return; root.replaceChildren(); const unread = rows.filter((row) => !row.read_at).length; const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'notification-badge'; badge.textContent = unread ? `Notifications (${unread})` : 'Notifications'; badge.addEventListener('click', async () => { for (const row of rows.filter((item) => !item.read_at)) await supabase?.rpc('mark_read', { notification_id: row.id }); await load(); }); root.append(badge); };
  const load = async () => { if (!supabase) return render([]); const { data } = await supabase.rpc('get_my_notifications', { limit_count: 20 }); render((data ?? []) as PlayerNotification[]); };
  void load();
  return () => { disposed = true; root.replaceChildren(); };
}

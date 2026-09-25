import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });

  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return Response.json({ error: 'not_authenticated' }, { status: 401 });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return Response.json({ error: 'server_not_configured' }, { status: 500 });

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return Response.json({ error: 'not_authenticated' }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (body?.confirmation !== 'DELETE MY ACCOUNT') return Response.json({ error: 'confirmation_required' }, { status: 400 });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const paths = await admin.from('runs').select('log_path').eq('player_id', user.id);
  if (paths.error) return Response.json({ error: 'deletion_failed' }, { status: 500 });
  const objects = (paths.data ?? []).map((row) => row.log_path).filter((path): path is string => typeof path === 'string');
  if (objects.length) await admin.storage.from('runs').remove(objects);
  const deletion = await admin.auth.admin.deleteUser(user.id);
  if (deletion.error && !deletion.error.message.toLowerCase().includes('not found')) {
    return Response.json({ error: 'deletion_failed' }, { status: 500 });
  }
  return Response.json({ deleted: true });
});

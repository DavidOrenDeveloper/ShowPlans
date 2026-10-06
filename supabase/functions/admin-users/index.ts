// ניהול עובדים – למנהל בלבד.  POST { action: 'create'|'reset'|'delete'|'setRole', ... }
import { authed, corsHeaders, json, service } from '../_shared/mod.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const a = await authed(req);
    if (!a) return json(req, { error: 'unauthorized' }, 401);
    const { data: isAdmin } = await a.client.rpc('is_admin');
    if (!isAdmin) return json(req, { error: 'forbidden' }, 403);
    if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
    const b = await req.json().catch(() => ({}));
    const sb = service();

    if (b.action === 'create') {
      const email = String(b.email ?? '').trim().toLowerCase();
      const password = String(b.password ?? '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, { error: 'bad_email' }, 400);
      if (password.length < 8) return json(req, { error: 'weak_password', message: 'סיסמה: לפחות 8 תווים' }, 400);
      const { data, error } = await sb.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { display_name: String(b.name ?? '').trim() || email.split('@')[0] },
      });
      if (error) return json(req, { error: 'create_failed', message: error.message }, 400);
      return json(req, { id: data.user.id });
    }
    if (b.action === 'reset') {
      const password = String(b.password ?? '');
      if (password.length < 8) return json(req, { error: 'weak_password', message: 'סיסמה: לפחות 8 תווים' }, 400);
      const { error } = await sb.auth.admin.updateUserById(String(b.userId), { password });
      if (error) return json(req, { error: 'reset_failed', message: error.message }, 400);
      return json(req, { ok: true });
    }
    if (b.action === 'delete') {
      if (b.userId === a.user.id) return json(req, { error: 'cannot_delete_self' }, 400);
      const { error } = await sb.auth.admin.deleteUser(String(b.userId));
      if (error) return json(req, { error: 'delete_failed', message: error.message }, 400);
      return json(req, { ok: true });
    }
    if (b.action === 'setRole') {
      if (b.userId === a.user.id) return json(req, { error: 'cannot_change_self' }, 400);
      if (!['admin', 'worker'].includes(b.role)) return json(req, { error: 'bad_role' }, 400);
      const { error } = await sb.from('profiles').update({ role: b.role }).eq('id', String(b.userId));
      if (error) return json(req, { error: 'db_error' }, 500);
      return json(req, { ok: true });
    }
    return json(req, { error: 'unknown_action' }, 400);
  } catch (e) {
    console.error(e);
    return json(req, { error: 'server_error', message: String((e as Error).message ?? e) }, 500);
  }
});

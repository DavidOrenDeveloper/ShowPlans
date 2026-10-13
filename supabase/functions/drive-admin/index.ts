// ניהול קבצי Drive של האפליקציה – למנהל בלבד.
//   POST { action: 'list' }                       ← רשימת הקבצים בתיקיית האפליקציה + האם הם בשימוש
//   POST { action: 'delete', fileIds: string[] }  ← העברת קבצים לפח של Drive (ניתן לשחזור כ-30 יום)
// קובץ שמשויך לגרסה פעילה: הגרסה מסומנת כמחוקה (ותיעלם מכל המכשירים), ואז הקובץ נשלח לפח.
import { authed, corsHeaders, DRIVE_FOLDER, googleToken, json, service } from '../_shared/mod.ts';

const API = 'https://www.googleapis.com/drive/v3/files';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const a = await authed(req);
    if (!a) return json(req, { error: 'unauthorized', message: 'לא מחובר' }, 401);
    const { data: isAdmin } = await a.client.rpc('is_admin');
    if (!isAdmin) return json(req, { error: 'forbidden', message: 'הפעולה זמינה למנהל בלבד' }, 403);
    if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
    const b = await req.json().catch(() => ({}));
    const token = await googleToken();
    const auth = { Authorization: `Bearer ${token}` };
    const sb = service();
    const folder = DRIVE_FOLDER();

    if (b.action === 'list') {
      const files: Array<{ id: string; name: string; size?: string; createdTime?: string }> = [];
      let pageToken = '';
      for (let i = 0; i < 30; i++) {
        const u = new URL(API);
        u.searchParams.set('q', `'${folder}' in parents and trashed = false`);
        u.searchParams.set('fields', 'nextPageToken,files(id,name,size,createdTime)');
        u.searchParams.set('pageSize', '1000');
        u.searchParams.set('orderBy', 'createdTime desc');
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const r = await fetch(u, { headers: auth });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json(req, { error: 'drive_error', step: 'list', status: r.status, message: `drive_error[list ${r.status}]: ${j?.error?.message ?? ''}` }, 502);
        files.push(...(j.files ?? []));
        pageToken = j.nextPageToken ?? '';
        if (!pageToken) break;
      }
      const used = new Map<string, { id: string; plan_id: string }>();
      for (let i = 0; i < files.length; i += 200) {
        const ids = files.slice(i, i + 200).map((f) => f.id);
        const { data, error } = await sb.from('versions').select('id,plan_id,drive_file_id').eq('deleted', false).in('drive_file_id', ids);
        if (error) return json(req, { error: 'db_error', step: 'versions', message: 'db_error[versions]: ' + error.message }, 500);
        for (const v of data ?? []) used.set(v.drive_file_id, v);
      }
      const planIds = [...new Set([...used.values()].map((v) => v.plan_id))];
      const planName = new Map<string, string>();
      for (let i = 0; i < planIds.length; i += 200) {
        const { data } = await sb.from('plans').select('id,data').in('id', planIds.slice(i, i + 200));
        for (const p of data ?? []) planName.set(p.id, String((p.data as { name?: string })?.name ?? ''));
      }
      return json(req, {
        files: files.map((f) => {
          const v = used.get(f.id);
          return { id: f.id, name: f.name, size: Number(f.size ?? 0), created: f.createdTime ?? null, versionId: v?.id ?? null, planName: v ? (planName.get(v.plan_id) ?? '') : null };
        }),
      });
    }

    if (b.action === 'delete') {
      const ids: string[] = Array.isArray(b.fileIds) ? b.fileIds.map(String).slice(0, 50) : [];
      if (!ids.length) return json(req, { error: 'bad_request', message: 'לא נבחרו קבצים' }, 400);
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      for (const id of ids) {
        try {
          const m = await fetch(`${API}/${encodeURIComponent(id)}?fields=id,parents,trashed`, { headers: auth });
          const mj = await m.json().catch(() => ({}));
          if (!m.ok && m.status !== 404) throw new Error(`drive[meta ${m.status}]: ${mj?.error?.message ?? ''}`);
          if (m.ok && !(mj.parents ?? []).includes(folder)) throw new Error('הקובץ לא נמצא בתיקיית האפליקציה, לא נמחק');
          const { error: ve } = await sb.from('versions').update({ deleted: true }).eq('drive_file_id', id).eq('deleted', false);
          if (ve) throw new Error('db_error[versions]: ' + ve.message);
          if (m.ok && !mj.trashed) {
            const t = await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
            if (!t.ok) { const tj = await t.json().catch(() => ({})); throw new Error(`drive[trash ${t.status}]: ${tj?.error?.message ?? ''}`); }
          }
          await sb.from('drive_files').delete().eq('file_id', id);
          results.push({ id, ok: true });
        } catch (e) {
          console.error('drive-admin delete', id, e);
          results.push({ id, ok: false, error: String((e as Error).message ?? e) });
        }
      }
      return json(req, { results });
    }

    return json(req, { error: 'bad_action', message: 'פעולה לא מוכרת' }, 400);
  } catch (e) {
    console.error(e);
    return json(req, { error: 'server_error', step: 'exception', message: String((e as Error).message ?? e) }, 500);
  }
});

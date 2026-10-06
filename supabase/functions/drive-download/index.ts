// הורדת PDF מ-Google Drive. הפונקציה בודקת בשם המשתמש (RLS) שהוא רשאי לראות את הגרסה,
// ואז מזרימה את הקובץ מ-Drive בלי לטעון אותו לזיכרון. תומכת ב-Range.
// קריאה: GET ?v=<versionId>   עם Authorization: Bearer <access token של המשתמש>
import { authed, corsHeaders, googleToken, json } from '../_shared/mod.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const a = await authed(req);
    if (!a) return json(req, { error: 'unauthorized' }, 401);
    const v = new URL(req.url).searchParams.get('v');
    if (!v) return json(req, { error: 'missing_version' }, 400);

    // RLS: אם אין למשתמש הרשאה – לא תחזור שורה
    const { data, error } = await a.client.from('versions').select('drive_file_id').eq('id', v).eq('deleted', false).maybeSingle();
    if (error) return json(req, { error: 'db_error' }, 500);
    if (!data) return json(req, { error: 'not_found_or_forbidden' }, 404);

    const token = await googleToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const range = req.headers.get('range');
    if (range) headers['Range'] = range;
    const g = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(data.drive_file_id)}?alt=media`, { headers });
    if (!g.ok && g.status !== 206) return json(req, { error: 'drive_error', status: g.status }, 502);

    const out = new Headers(corsHeaders(req));
    out.set('Content-Type', 'application/pdf');
    for (const h of ['content-length', 'content-range', 'accept-ranges']) { const x = g.headers.get(h); if (x) out.set(h, x); }
    out.set('Cache-Control', 'private, max-age=0, no-store');
    return new Response(g.body, { status: g.status, headers: out });
  } catch (e) {
    console.error(e);
    return json(req, { error: 'server_error', message: String((e as Error).message ?? e) }, 500);
  }
});

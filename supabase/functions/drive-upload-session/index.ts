// יוצר "session" להעלאה ישירה מהטלפון אל Google Drive (resumable upload), אחרי בדיקת הרשאה.
// הקובץ לא עובר דרך Supabase, ולכן אין מגבלת גודל/זמן של הפונקציה.
// קריאה: POST { folderId?: string|null, planId?: string|null, name: string, size: number }
// תשובה:  { fileId, uploadUrl }  – הלקוח עושה PUT של הקובץ אל uploadUrl.
import { authed, corsHeaders, DRIVE_FOLDER, googleToken, json, MAX_UPLOAD_BYTES, service } from '../_shared/mod.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  try {
    const a = await authed(req);
    if (!a) return json(req, { error: 'unauthorized' }, 401);
    if (req.method !== 'POST') return json(req, { error: 'method' }, 405);
    const b = await req.json().catch(() => ({}));

    // אימות שההעלאה הושלמה (הדפדפן לא תמיד יכול לקרוא את תשובת Google בגלל CORS)
    if (b.action === 'verify') {
      const { data: row } = await service().from('drive_files').select('file_id').eq('file_id', String(b.fileId)).eq('created_by', a.user.id).maybeSingle();
      if (!row) return json(req, { error: 'unknown_file' }, 404);
      const g = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.file_id)}?fields=size`, { headers: { Authorization: `Bearer ${await googleToken()}` } });
      if (!g.ok) return json(req, { exists: false });
      const j = await g.json();
      return json(req, { exists: true, size: Number(j.size) });
    }

    const folderId: string | null = b.folderId ?? null;
    const planId: string | null = b.planId ?? null;
    const size = Number(b.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) return json(req, { error: 'bad_size' }, 400);

    // בדיקת הרשאה בשם המשתמש (פונקציית SQL עם RLS-aware logic)
    const { data: ok, error } = await a.client.rpc('can_upload', { p_folder: folderId, p_plan: planId });
    if (error) return json(req, { error: 'db_error' }, 500);
    if (!ok) return json(req, { error: 'forbidden' }, 403);

    const token = await googleToken();
    // מזהה קובץ שמור מראש – כך אפשר לרשום אותו לפני ההעלאה ולמנוע הצבעה על קבצים של אחרים
    const idRes = await fetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive', { headers: { Authorization: `Bearer ${token}` } });
    const idJ = await idRes.json();
    const fileId: string | undefined = idJ?.ids?.[0];
    if (!idRes.ok || !fileId) return json(req, { error: 'drive_error', step: 'generateIds' }, 502);

    const safe = String(b.name ?? 'plan.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'plan.pdf';
    const origin = req.headers.get('origin') ?? '';
    const s = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/pdf',
        'X-Upload-Content-Length': String(size),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ id: fileId, name: safe, mimeType: 'application/pdf', parents: [DRIVE_FOLDER()] }),
    });
    const uploadUrl = s.headers.get('location');
    if (!s.ok || !uploadUrl) return json(req, { error: 'drive_error', step: 'session', status: s.status }, 502);

    const { error: e2 } = await service().from('drive_files').insert({ file_id: fileId, created_by: a.user.id, folder_id: folderId, plan_id: planId });
    if (e2) return json(req, { error: 'db_error' }, 500);
    return json(req, { fileId, uploadUrl });
  } catch (e) {
    console.error(e);
    return json(req, { error: 'server_error', message: String((e as Error).message ?? e) }, 500);
  }
});

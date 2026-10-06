// כלי עזר משותפים לפונקציות: CORS, אימות משתמש, ואסימון גישה ל-Google Drive.
import { createClient, SupabaseClient, User } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') ?? '';
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : (allowed[0] ?? ''),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type, range, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges, content-type',
    'Access-Control-Max-Age': '86400',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// לקוח שפועל בשם המשתמש (RLS חל עליו) + המשתמש עצמו. null אם לא מחובר.
export async function authed(req: Request): Promise<{ client: SupabaseClient; user: User } | null> {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const key = env('SUPABASE_ANON_KEY') || env('PUBLISHABLE_KEY');
  const client = createClient(env('SUPABASE_URL'), key, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser(auth.slice(7));
  if (error || !data?.user) return null;
  return { client, user: data.user };
}

// לקוח עם הרשאות מלאות – רק לשימוש פנימי בשרת, אחרי שבדקנו הרשאה
export function service(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let cached: { token: string; exp: number } | null = null;
export async function googleToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env('GOOGLE_CLIENT_ID'),
      client_secret: env('GOOGLE_CLIENT_SECRET'),
      refresh_token: env('GOOGLE_REFRESH_TOKEN'),
      grant_type: 'refresh_token',
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('google_token_failed: ' + (j.error_description || j.error || res.status));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export const DRIVE_FOLDER = () => env('DRIVE_FOLDER_ID');
export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

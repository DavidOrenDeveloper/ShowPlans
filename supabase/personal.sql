-- שכבה אישית לכל משתמש (שמות, הסתרה, תיקיות אישיות) והסכמה לתנאי שימוש ופרטיות.
-- להריץ ב-SQL Editor אחרי schema.sql ו-items-sync.sql. בטוח להריץ שוב.

-- 1) שכבה אישית: כל שורה שייכת למשתמש אחד ונראית רק לו (ולמנהל, לצורך "צפייה כעובד").
--    kind: 'folder' | 'plan'  = שינוי אישי של פריט משותף (data: name / hidden / parentId)
--          'pfolder'          = תיקייה אישית (data: name / parentId)
create table if not exists public.user_overrides (
  user_id    uuid not null references auth.users(id) on delete cascade,
  id         text not null,
  kind       text not null check (kind in ('folder','plan','pfolder')),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists user_overrides_user_idx on public.user_overrides(user_id, updated_at);

create or replace function public.touch_override() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.user_id := case when tg_op = 'UPDATE' then old.user_id else new.user_id end; return new; end $$;
drop trigger if exists user_overrides_touch on public.user_overrides;
create trigger user_overrides_touch before insert or update on public.user_overrides for each row execute function public.touch_override();

alter table public.user_overrides enable row level security;
drop policy if exists uo_select on public.user_overrides;
drop policy if exists uo_insert on public.user_overrides;
drop policy if exists uo_update on public.user_overrides;
drop policy if exists uo_delete on public.user_overrides;
create policy uo_select on public.user_overrides for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy uo_insert on public.user_overrides for insert to authenticated with check (user_id = auth.uid());
create policy uo_update on public.user_overrides for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy uo_delete on public.user_overrides for delete to authenticated using (user_id = auth.uid());
grant select, insert, update, delete on public.user_overrides to authenticated;

-- 2) הסכמה לתנאי שימוש ופרטיות: תיעוד מי אישר איזו גרסת נוסח ומתי. משתמש רואה ורושם רק את שלו; מנהל רואה את כולם.
create table if not exists public.consents (
  user_id     uuid not null references auth.users(id) on delete cascade,
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);
alter table public.consents enable row level security;
drop policy if exists consents_select on public.consents;
drop policy if exists consents_insert on public.consents;
create policy consents_select on public.consents for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy consents_insert on public.consents for insert to authenticated with check (user_id = auth.uid());
grant select, insert on public.consents to authenticated;

-- 3) עדכון חי של השכבה האישית בין מכשירים של אותו משתמש
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.user_overrides'; exception when others then null; end;
end $$;

-- 4) מימוש זכויות (עיון ומחיקה), למנהל בלבד
-- ייצוא כל המידע שנשמר על משתמש (JSON): חשבון, הרשאות, אישורים, שכבה אישית, וסימונים שיצר
create or replace function public.export_user_data(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object(
    'exported_at', now(),
    'profile',   (select to_jsonb(p) from public.profiles p where p.id = p_user),
    'grants',    coalesce((select jsonb_agg(to_jsonb(g)) from public.grants g where g.user_id = p_user), '[]'::jsonb),
    'consents',  coalesce((select jsonb_agg(to_jsonb(c)) from public.consents c where c.user_id = p_user), '[]'::jsonb),
    'overrides', coalesce((select jsonb_agg(to_jsonb(o)) from public.user_overrides o where o.user_id = p_user), '[]'::jsonb),
    'items',     coalesce((select jsonb_agg(to_jsonb(i)) from public.items i where i.owner_id = p_user and not i.deleted), '[]'::jsonb)
  );
end $$;

-- מחיקת הסימונים והמדידות שהמשתמש יצר (נשארים כמחיקה זמנית לסנכרון מכשירים, ומוסרים סופית אחרי 30 יום)
-- ומחיקת השכבה האישית והאישורים שלו. לא מוחקת את המשתמש עצמו (זה במסך "ניהול עובדים").
create or replace function public.erase_user_data(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n_items int; n_over int;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.items set deleted = true, data = '{}'::jsonb where owner_id = p_user and not deleted;
  get diagnostics n_items = row_count;
  delete from public.item_shares where user_id = p_user or exists (select 1 from public.items i where i.id = item_id and i.owner_id = p_user);
  delete from public.author_shares where viewer_id = p_user or author_id = p_user;
  delete from public.user_overrides where user_id = p_user;
  get diagnostics n_over = row_count;
  delete from public.consents where user_id = p_user;
  return jsonb_build_object('items', n_items, 'overrides', n_over);
end $$;
revoke all on function public.export_user_data(uuid), public.erase_user_data(uuid) from public;
grant execute on function public.export_user_data(uuid), public.erase_user_data(uuid) to authenticated;

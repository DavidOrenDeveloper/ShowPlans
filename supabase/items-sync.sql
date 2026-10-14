-- =====================================================================
-- סימונים, מדידות, כיולים וקישורים: הרשאות, שיתוף וניקוי (שלב 2)
-- להרצה ב-SQL Editor של Supabase אחרי schema.sql. בטוח להריץ שוב (idempotent).
--
-- כללים:
--  * סימון/מדידה הם פרטיים לבעלים שלהם. המנהל רואה ועורך הכול.
--  * אפשר לשתף פריט (או את כל הסימונים של כותב) עם עובד מסוים: צפייה או עריכה. אפשר לבטל בכל רגע.
--  * כיולים וקישורים משותפים לכל מי שרואה את התוכנית; יצירה/עריכה רק ברמת "עריכה מלאה" ומעלה.
--  * עובד חייב קודם גישה לתוכנית (צפייה לפחות) כדי לראות פריט ששיתפו איתו.
--  * מחיקה = deleted=true. ניקוי סופי אוטומטי אחרי 30 יום (purge_deleted).
-- =====================================================================

-- ---------- טבלאות שיתוף ----------
create table if not exists public.item_shares (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  plan_id text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  level text not null check (level in ('view','edit')),
  granted_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (item_id, user_id)
);
create index if not exists item_shares_user_idx on public.item_shares(user_id);
create index if not exists item_shares_item_idx on public.item_shares(item_id);

-- "כל הסימונים של הכותב X" גלויים/ניתנים לעריכה ל-Y, בהיקף: תוכנית / תיקייה (וכל מה שבתוכה) / הכול
create table if not exists public.author_shares (
  id uuid primary key default gen_random_uuid(),
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  plan_id text,
  folder_id text,
  level text not null check (level in ('view','edit')),
  granted_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  check (plan_id is null or folder_id is null)
);
create unique index if not exists author_shares_plan_uq on public.author_shares(viewer_id, author_id, plan_id) where plan_id is not null;
create unique index if not exists author_shares_folder_uq on public.author_shares(viewer_id, author_id, folder_id) where folder_id is not null;
create unique index if not exists author_shares_all_uq on public.author_shares(viewer_id, author_id) where plan_id is null and folder_id is null;
create index if not exists author_shares_viewer_idx on public.author_shares(viewer_id);

create index if not exists items_plan_owner_idx on public.items(plan_id, owner_id);
create index if not exists items_deleted_idx on public.items(updated_at) where deleted;

-- ---------- פונקציות עזר ----------
-- האם התוכנית נמצאת בתיקייה fid או בתת-תיקייה שלה
create or replace function public.plan_in_folder(pid text, fid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    with recursive up(id, parent_id) as (
      select f.id, f.parent_id from public.folders f join public.plans p on p.folder_id = f.id where p.id = pid
      union
      select f.id, f.parent_id from public.folders f join up on f.id = up.parent_id
    )
    select 1 from up where id = fid)
$$;

-- רמת שיתוף של הפריט עבור המשתמש הנוכחי: 0 אין, 1 צפייה, 2 עריכה
create or replace function public.item_share_level(p_item text, p_plan text, p_owner uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(case x.level when 'edit' then 2 when 'view' then 1 else 0 end), 0)
  from (
    select s.level from public.item_shares s where s.item_id = p_item and s.user_id = auth.uid()
    union all
    select a.level from public.author_shares a
    where a.viewer_id = auth.uid() and a.author_id = p_owner
      and ((a.plan_id is null and a.folder_id is null)
           or a.plan_id = p_plan
           or (a.folder_id is not null and public.plan_in_folder(p_plan, a.folder_id)))
  ) x
$$;

create or replace function public.item_can_see(p_item text, p_plan text, p_kind text, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    public.plan_level(p_plan) >= 1 and (
      p_kind in ('calibrations','links')
      or p_owner = auth.uid()
      or public.item_share_level(p_item, p_plan, p_owner) >= 1))
$$;

create or replace function public.item_can_edit(p_item text, p_plan text, p_kind text, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or case
    when p_kind in ('calibrations','links') then public.plan_level(p_plan) >= 3
    else public.plan_level(p_plan) >= 1 and (
      (p_owner = auth.uid() and public.plan_level(p_plan) >= 2)
      or public.item_share_level(p_item, p_plan, p_owner) >= 2)
  end
$$;

-- האם למשתמש מסוים (לא בהכרח הנוכחי) יש גישת צפייה לתוכנית
create or replace function public.has_plan_access(p_user uuid, pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_user and role = 'admin')
      or exists (select 1 from public.grants g where g.user_id = p_user and g.plan_id = pid)
      or exists (
        with recursive up(id, parent_id) as (
          select f.id, f.parent_id from public.folders f join public.plans p on p.folder_id = f.id where p.id = pid
          union
          select f.id, f.parent_id from public.folders f join up on f.id = up.parent_id
        )
        select 1 from public.grants g where g.user_id = p_user and g.folder_id in (select id from up))
$$;

-- ---------- RLS על items ----------
drop policy if exists items_select on public.items;
drop policy if exists items_insert on public.items;
drop policy if exists items_update on public.items;

create policy items_select on public.items for select to authenticated
  using (public.item_can_see(id, plan_id, kind, owner_id));

create policy items_insert on public.items for insert to authenticated
  with check (
    owner_id = auth.uid() and (
      public.is_admin()
      or (kind in ('markups','measurements') and public.plan_level(plan_id) >= 2)
      or (kind in ('calibrations','links') and public.plan_level(plan_id) >= 3)));

create policy items_update on public.items for update to authenticated
  using (public.item_can_edit(id, plan_id, kind, owner_id))
  with check (public.item_can_edit(id, plan_id, kind, owner_id));

-- ---------- RLS על טבלאות השיתוף (כתיבה רק דרך הפונקציות למטה) ----------
alter table public.item_shares enable row level security;
alter table public.author_shares enable row level security;
drop policy if exists item_shares_select on public.item_shares;
drop policy if exists author_shares_select on public.author_shares;
create policy item_shares_select on public.item_shares for select to authenticated
  using (user_id = auth.uid() or granted_by = auth.uid() or public.is_admin());
create policy author_shares_select on public.author_shares for select to authenticated
  using (viewer_id = auth.uid() or author_id = auth.uid() or granted_by = auth.uid() or public.is_admin());

revoke all on public.item_shares, public.author_shares from anon, authenticated;
grant select on public.item_shares, public.author_shares to authenticated;

-- ---------- שיתוף פריטים (כמה פריטים × כמה עובדים בבת אחת) ----------
-- p_level: 'view' | 'edit' | 'none' (ביטול). p_add_access: מנהל בלבד – להוסיף גישת צפייה לתוכנית למי שאין לו.
-- מי רשאי לשתף פריט: מנהל, או מי שברמת "עריכה מלאה" על התוכנית ורשאי לערוך את הפריט.
create or replace function public.share_items(p_items text[], p_users uuid[], p_level text, p_add_access boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it record; u uuid; n int := 0; skipped int := 0; noacc uuid[] := '{}';
begin
  if auth.uid() is null then raise exception 'לא מחובר'; end if;
  if p_level not in ('none','view','edit') then raise exception 'רמה לא תקינה'; end if;
  for it in select i.id, i.plan_id, i.kind, i.owner_id from public.items i where i.id = any(p_items) and not i.deleted loop
    if it.kind not in ('markups','measurements')
       or not (public.is_admin() or (public.plan_level(it.plan_id) >= 3 and public.item_can_edit(it.id, it.plan_id, it.kind, it.owner_id))) then
      skipped := skipped + 1; continue;
    end if;
    foreach u in array p_users loop
      if u = it.owner_id then continue; end if;
      if p_level = 'none' then
        delete from public.item_shares where item_id = it.id and user_id = u;
      else
        if not public.has_plan_access(u, it.plan_id) then
          if p_add_access and public.is_admin() then
            insert into public.grants(user_id, plan_id, level) values (u, it.plan_id, 'view') on conflict do nothing;
          else
            noacc := array_append(noacc, u);
          end if;
        end if;
        insert into public.item_shares(item_id, plan_id, user_id, level) values (it.id, it.plan_id, u, p_level)
        on conflict (item_id, user_id) do update set level = excluded.level, granted_by = auth.uid(), plan_id = excluded.plan_id;
      end if;
      n := n + 1;
    end loop;
  end loop;
  return jsonb_build_object('count', n, 'skipped', skipped,
    'noAccess', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(noacc) x));
end $$;

-- ---------- שיתוף כל הסימונים של כותב ----------
-- היקף: p_plan / p_folder / שניהם null (= הכול, מנהל בלבד). מנהל משתף של כל כותב; עורך משתף רק את שלו בתוכנית/תיקייה שברמת עריכה.
create or replace function public.share_author(p_author uuid, p_viewers uuid[], p_plan text, p_folder text, p_level text, p_add_access boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare u uuid; n int := 0; noacc uuid[] := '{}';
begin
  if auth.uid() is null then raise exception 'לא מחובר'; end if;
  if p_level not in ('none','view','edit') then raise exception 'רמה לא תקינה'; end if;
  if p_plan is not null and p_folder is not null then raise exception 'יש לבחור תוכנית או תיקייה, לא שתיהן'; end if;
  if not public.is_admin() then
    if p_author is distinct from auth.uid() then raise exception 'אין הרשאה לשתף סימונים של אחרים'; end if;
    if p_plan is not null then
      if public.plan_level(p_plan) < 3 then raise exception 'אין הרשאה'; end if;
    elsif p_folder is not null then
      if public.folder_level(p_folder) < 3 then raise exception 'אין הרשאה'; end if;
    else raise exception 'אין הרשאה לשיתוף כללי'; end if;
  end if;
  foreach u in array p_viewers loop
    if u = p_author then continue; end if;
    delete from public.author_shares
      where viewer_id = u and author_id = p_author and plan_id is not distinct from p_plan and folder_id is not distinct from p_folder;
    if p_level <> 'none' then
      if p_plan is not null and not public.has_plan_access(u, p_plan) then
        if p_add_access and public.is_admin() then
          insert into public.grants(user_id, plan_id, level) values (u, p_plan, 'view') on conflict do nothing;
        else noacc := array_append(noacc, u); end if;
      end if;
      insert into public.author_shares(viewer_id, author_id, plan_id, folder_id, level) values (u, p_author, p_plan, p_folder, p_level);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('count', n, 'noAccess', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(noacc) x));
end $$;

-- ---------- שמות משתמשים לממשק השיתוף והסינון ----------
-- מנהל: כולם. עורך (יש לו הרשאת edit): כל העובדים. אחרים: עצמם + מי ששיתף איתם.
create or replace function public.people() returns table(id uuid, display_name text, email text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, case when public.is_admin() then p.email end, p.role
  from public.profiles p
  where auth.uid() is not null and (
    public.is_admin()
    or p.id = auth.uid()
    or exists (select 1 from public.grants g where g.user_id = auth.uid() and g.level = 'edit')
    or p.id in (select i.owner_id from public.item_shares s join public.items i on i.id = s.item_id where s.user_id = auth.uid())
    or p.id in (select a.author_id from public.author_shares a where a.viewer_id = auth.uid()))
$$;

-- ---------- ניקוי סופי של מחיקות ישנות ----------
-- מוחק לצמיתות שורות deleted=true שעברו p_days ימים, ופריטים/שיתופים של תוכניות שנמחקו.
-- מכשיר שהיה offline יותר מזה מתעדכן בהתאמה המלאה (reconcile) בחיבור הבא.
create or replace function public.purge_deleted(p_days int default 30) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cutoff timestamptz := now() - make_interval(days => greatest(p_days, 1)); a int; b int; c int; d int; e int; f int;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'מנהל בלבד'; end if;
  delete from public.items i where i.deleted and i.updated_at < cutoff;                     get diagnostics a = row_count;
  delete from public.items i where not exists (select 1 from public.plans p where p.id = i.plan_id)
     or exists (select 1 from public.plans p where p.id = i.plan_id and p.deleted and p.updated_at < cutoff); get diagnostics b = row_count;
  delete from public.versions v where v.deleted and v.updated_at < cutoff;                  get diagnostics c = row_count;
  delete from public.plans p where p.deleted and p.updated_at < cutoff
     and not exists (select 1 from public.versions v where v.plan_id = p.id);               get diagnostics d = row_count;
  delete from public.folders f where f.deleted and f.updated_at < cutoff
     and not exists (select 1 from public.folders c2 where c2.parent_id = f.id)
     and not exists (select 1 from public.plans p where p.folder_id = f.id);                get diagnostics e = row_count;
  delete from public.item_shares s where not exists (select 1 from public.items i where i.id = s.item_id); get diagnostics f = row_count;
  return jsonb_build_object('items', a + b, 'versions', c, 'plans', d, 'folders', e, 'shares', f);
end $$;

-- ---------- הרשאות הרצה ----------
revoke execute on function public.plan_in_folder(text, text), public.item_share_level(text, text, uuid),
  public.item_can_see(text, text, text, uuid), public.item_can_edit(text, text, text, uuid), public.has_plan_access(uuid, text) from public;
grant execute on function public.plan_in_folder(text, text), public.item_share_level(text, text, uuid),
  public.item_can_see(text, text, text, uuid), public.item_can_edit(text, text, text, uuid) to authenticated;
revoke execute on function public.share_items(text[], uuid[], text, boolean), public.share_author(uuid, uuid[], text, text, text, boolean),
  public.people(), public.purge_deleted(int) from public, anon;
grant execute on function public.share_items(text[], uuid[], text, boolean), public.share_author(uuid, uuid[], text, text, text, boolean),
  public.people(), public.purge_deleted(int) to authenticated;

-- ---------- Realtime ----------
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['items','item_shares','author_shares'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;

-- ---------- ניקוי אוטומטי יומי (pg_cron). אם התוסף לא פעיל – הפקודה מדלגת בלי שגיאה ---------
-- להפעלה: Supabase ← Database ← Extensions ← pg_cron (Enable), ואז להריץ את הקובץ שוב.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'purge-deleted';
    perform cron.schedule('purge-deleted', '17 3 * * *', 'select public.purge_deleted(30)');
  else
    raise notice 'pg_cron לא פעיל. הניקוי האוטומטי לא מתוזמן (אפשר להפעיל את התוסף ולהריץ שוב, או להריץ ידנית: select public.purge_deleted(30);)';
  end if;
end $$;

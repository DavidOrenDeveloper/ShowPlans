-- =====================================================================
-- עדכון v2 (גרסה 1.12.0). להריץ פעם אחת ב-SQL Editor של Supabase, אחרי schema.sql ו-items-sync.sql. בטוח להריץ שוב.
--
-- 1) חסימה מפורשת: אפשר לסמן תוכנית (או תת-תיקייה) כ"חסומה" לעובד גם כשהתיקייה שמעליה מותרת לו.
--    הכלל החדש: ההרשאה הקרובה ביותר קובעת (הרשאה על התוכנית עצמה, אחרת על התיקייה שלה, אחרת על תיקיית האב...).
--    רמה 'none' = חסום.
-- 2) כיולים נפרדים לכל משתמש: כל משתמש רואה ועורך רק את הכיולים שלו (המנהל רואה הכול).
--    כיול של המנהל שסומן "שתף" (data.shared = true) נראה גם לעובדים שאין להם כיול משלהם.
--    כיול דורש רמת "סימון" ומעלה (ולא עריכה מלאה), כי הוא משפיע רק על המשתמש עצמו.
-- =====================================================================

-- ---------- 1) חסימה מפורשת ----------
alter table public.grants drop constraint if exists grants_level_check;
alter table public.grants add constraint grants_level_check check (level in ('none','view','mark','edit'));

create or replace function public.folder_level_for(u uuid, fid text) returns int
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.profiles where id = u and role = 'admin') then 4
    when fid is null then 0
    else coalesce((
      with recursive up(id, parent_id, depth) as (
        select id, parent_id, 0 from public.folders where id = fid
        union all
        select f.id, f.parent_id, up.depth + 1 from public.folders f join up on f.id = up.parent_id where up.depth < 60
      )
      select public.lvl(g.level) from public.grants g join up on g.folder_id = up.id
      where g.user_id = u
      order by up.depth asc
      limit 1
    ), 0)
  end
$$;

create or replace function public.plan_level_for(u uuid, pid text) returns int
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.profiles where id = u and role = 'admin') then 4
    else coalesce(
      (select public.lvl(g.level) from public.grants g where g.user_id = u and g.plan_id = pid limit 1),
      (select public.folder_level_for(u, p.folder_id) from public.plans p where p.id = pid),
      0)
  end
$$;

create or replace function public.folder_level(fid text) returns int
language sql stable security definer set search_path = public as $$
  select public.folder_level_for(auth.uid(), fid)
$$;

create or replace function public.plan_level(pid text) returns int
language sql stable security definer set search_path = public as $$
  select public.plan_level_for(auth.uid(), pid)
$$;

-- תיקייה "נראית" אם יש עליה הרשאה, או שיש תוכנית נגישה (או הרשאה שאינה חסימה) בתוך עץ התיקיות שמתחתיה
create or replace function public.folder_visible(fid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.folder_level(fid) >= 1 or exists (
    with recursive down(id, depth) as (
      select id, 0 from public.folders where id = fid
      union all
      select f.id, d.depth + 1 from public.folders f join down d on f.parent_id = d.id where d.depth < 60
    )
    select 1 from public.plans p
      where p.folder_id in (select id from down) and not p.deleted and public.plan_level(p.id) >= 1
    union all
    select 1 from public.grants g
      where g.user_id = auth.uid() and g.level <> 'none' and g.folder_id in (select id from down)
  )
$$;

create or replace function public.has_plan_access(p_user uuid, pid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.plan_level_for(p_user, pid) >= 1
$$;

revoke execute on function public.folder_level_for(uuid, text), public.plan_level_for(uuid, text) from public;
revoke execute on function public.has_plan_access(uuid, text) from public;
grant execute on function public.folder_level(text), public.plan_level(text), public.folder_visible(text) to authenticated;

-- ---------- 2) כיולים נפרדים לכל משתמש ----------
create or replace function public.item_can_see(p_item text, p_plan text, p_kind text, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    public.plan_level(p_plan) >= 1 and (
      p_kind = 'links'
      or p_owner = auth.uid()
      or (p_kind = 'calibrations' and exists (select 1 from public.items i where i.id = p_item and i.data->>'shared' = 'true'))
      or public.item_share_level(p_item, p_plan, p_owner) >= 1))
$$;

create or replace function public.item_can_edit(p_item text, p_plan text, p_kind text, p_owner uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or case
    when p_kind = 'links' then public.plan_level(p_plan) >= 3
    when p_kind = 'calibrations' then p_owner = auth.uid() and public.plan_level(p_plan) >= 2
    else public.plan_level(p_plan) >= 1 and (
      (p_owner = auth.uid() and public.plan_level(p_plan) >= 2)
      or public.item_share_level(p_item, p_plan, p_owner) >= 2)
  end
$$;

drop policy if exists items_insert on public.items;
create policy items_insert on public.items for insert to authenticated
  with check (
    owner_id = auth.uid() and (
      public.is_admin()
      or (kind in ('markups','measurements','calibrations') and public.plan_level(plan_id) >= 2)
      or (kind = 'links' and public.plan_level(plan_id) >= 3)));

-- כיולים קיימים (שהיו משותפים עד היום) נשארים נראים לכולם, כדי שלא יאבדו. מכאן והלאה כל כיול חדש פרטי אלא אם המנהל סימן "שתף".
update public.items set data = jsonb_set(coalesce(data, '{}'::jsonb), '{shared}', 'true'::jsonb)
 where kind = 'calibrations' and (data->>'shared') is null and not deleted;

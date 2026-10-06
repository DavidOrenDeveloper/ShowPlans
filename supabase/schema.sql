-- =====================================================================
-- סכמת הענן של אפליקציית התוכניות (Supabase / PostgreSQL)
-- להרצה פעם אחת ב-SQL Editor של Supabase. בטוח להריץ שוב (idempotent).
-- רמות הרשאה:  view=צפייה בלבד · mark=צפייה + סימונים · edit=עריכה מלאה · מנהל=הכול
-- =====================================================================

-- ---------- משתמשים ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'worker' check (role in ('admin','worker')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- משתמשים שנוצרו לפני ההתקנה
insert into public.profiles(id, email, display_name)
select id, email, split_part(email,'@',1) from auth.users
on conflict (id) do nothing;

-- ---------- טבלאות נתונים ----------
-- data = כל הרשומה כפי שהאפליקציה שומרת אותה מקומית (כך שכל שדה חדש מסתנכרן אוטומטית).
create table if not exists public.folders (
  id text primary key,
  parent_id text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create table if not exists public.plans (
  id text primary key,
  folder_id text,
  data jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create table if not exists public.versions (
  id text primary key,
  plan_id text not null,
  drive_file_id text not null,
  data jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create unique index if not exists versions_drive_file_uq on public.versions(drive_file_id);
-- סימונים, מדידות, קישורים וכיולים (שלב 2 – הטבלה והכללים כבר כאן)
create table if not exists public.items (
  id text primary key,
  version_id text not null,
  plan_id text not null,
  kind text not null check (kind in ('markups','measurements','links','calibrations')),
  owner_id uuid not null default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
-- קבצים שהשרת הכין להם מקום ב-Drive (כדי שאי אפשר יהיה לכוון גרסה לקובץ של מישהו אחר)
create table if not exists public.drive_files (
  file_id text primary key,
  created_by uuid not null,
  folder_id text,
  plan_id text,
  created_at timestamptz not null default now()
);
create table if not exists public.grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  folder_id text,
  plan_id text,
  level text not null check (level in ('view','mark','edit')),
  created_at timestamptz not null default now(),
  check (num_nonnulls(folder_id, plan_id) = 1)
);
create unique index if not exists grants_user_folder_uq on public.grants(user_id, folder_id) where folder_id is not null;
create unique index if not exists grants_user_plan_uq on public.grants(user_id, plan_id) where plan_id is not null;

create index if not exists folders_updated_idx on public.folders(updated_at);
create index if not exists plans_updated_idx on public.plans(updated_at);
create index if not exists versions_updated_idx on public.versions(updated_at);
create index if not exists versions_plan_idx on public.versions(plan_id);
create index if not exists items_updated_idx on public.items(updated_at);
create index if not exists items_version_idx on public.items(version_id);

-- ---------- פונקציות הרשאה ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.lvl(l text) returns int
language sql immutable as $$
  select case l when 'view' then 1 when 'mark' then 2 when 'edit' then 3 else 0 end
$$;

-- רמת ההרשאה האפקטיבית על תיקייה (הרשאה על תיקייה חלה גם על כל מה שבתוכה)
create or replace function public.folder_level(fid text) returns int
language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin() then 4
    when fid is null then 0
    else coalesce((
      with recursive up(id, parent_id) as (
        select id, parent_id from public.folders where id = fid
        union
        select f.id, f.parent_id from public.folders f join up on f.id = up.parent_id
      )
      select max(public.lvl(g.level)) from public.grants g
      where g.user_id = auth.uid() and g.folder_id in (select id from up)
    ), 0)
  end
$$;

create or replace function public.plan_level(pid text) returns int
language sql stable security definer set search_path = public as $$
  select case
    when public.is_admin() then 4
    else greatest(
      coalesce((select public.folder_level(p.folder_id) from public.plans p where p.id = pid), 0),
      coalesce((select max(public.lvl(g.level)) from public.grants g where g.user_id = auth.uid() and g.plan_id = pid), 0)
    )
  end
$$;

-- תיקייה "נראית" אם יש עליה הרשאה, או שיש הרשאה על משהו שבתוכה (כדי שאפשר יהיה לנווט אליו)
create or replace function public.folder_visible(fid text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.folder_level(fid) >= 1 or exists (
    with recursive down(id) as (
      select id from public.folders where id = fid
      union
      select f.id from public.folders f join down d on f.parent_id = d.id
    )
    select 1 from public.grants g
    where g.user_id = auth.uid()
      and (g.folder_id in (select id from down)
           or g.plan_id in (select p.id from public.plans p where p.folder_id in (select id from down)))
  )
$$;

-- האם המשתמש רשאי להעלות קובץ (תוכנית חדשה בתיקייה / גרסה חדשה לתוכנית)
create or replace function public.can_upload(p_folder text, p_plan text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_plan is not null then public.plan_level(p_plan) >= 3
    when p_folder is null then public.is_admin()
    else public.folder_level(p_folder) >= 3
  end
$$;

create or replace function public.ping() returns timestamptz
language sql stable security definer set search_path = public as $$ select now() $$;

-- ---------- טריגרים ----------
create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

create or replace function public.lock_drive_id() returns trigger
language plpgsql as $$
begin
  if new.drive_file_id is distinct from old.drive_file_id then
    raise exception 'drive_file_id לא ניתן לשינוי';
  end if;
  return new;
end $$;

create or replace function public.lock_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := old.created_at;
  if new.owner_id is distinct from old.owner_id and not public.is_admin() then
    new.owner_id := old.owner_id;
  end if;
  new.version_id := old.version_id; new.plan_id := old.plan_id; new.kind := old.kind;
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- העברת תיקייה/תוכנית ליעד חדש מותרת רק למי שיש לו עריכה מלאה ביעד
create or replace function public.check_move() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'folders' and new.parent_id is distinct from old.parent_id
     and not public.can_upload(new.parent_id, null) then
    raise exception 'אין הרשאה להעביר ליעד הזה';
  end if;
  if tg_table_name = 'plans' and new.folder_id is distinct from old.folder_id
     and not public.can_upload(new.folder_id, null) then
    raise exception 'אין הרשאה להעביר ליעד הזה';
  end if;
  return new;
end $$;

create or replace function public.protect_profile() returns trigger
language plpgsql as $$
begin
  new.id := old.id; new.email := old.email;
  return new;
end $$;

do $$ declare t text; begin
  foreach t in array array['folders','plans','versions'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I for each row execute function public.touch_row()', t);
  end loop;
end $$;
drop trigger if exists check_move_f on public.folders;
create trigger check_move_f before update on public.folders for each row execute function public.check_move();
drop trigger if exists check_move_p on public.plans;
create trigger check_move_p before update on public.plans for each row execute function public.check_move();
drop trigger if exists lock_drive on public.versions;
create trigger lock_drive before update on public.versions for each row execute function public.lock_drive_id();
drop trigger if exists items_touch_ins on public.items;
create trigger items_touch_ins before insert on public.items for each row execute function public.touch_row();
drop trigger if exists items_lock on public.items;
create trigger items_lock before update on public.items for each row execute function public.lock_owner();
drop trigger if exists profile_protect on public.profiles;
create trigger profile_protect before update on public.profiles for each row execute function public.protect_profile();

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.folders enable row level security;
alter table public.plans enable row level security;
alter table public.versions enable row level security;
alter table public.items enable row level security;
alter table public.drive_files enable row level security;
alter table public.grants enable row level security;

do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in ('profiles','folders','plans','versions','items','drive_files','grants') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- profiles: כל אחד רואה את עצמו, מנהל רואה ומשנה את כולם
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- grants: רק מנהל מנהל; עובד רואה את ההרשאות של עצמו
create policy grants_select on public.grants for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy grants_admin_ins on public.grants for insert to authenticated with check (public.is_admin());
create policy grants_admin_upd on public.grants for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy grants_admin_del on public.grants for delete to authenticated using (public.is_admin());

-- drive_files: נכתב רק ע"י פונקציית השרת (service role); המשתמש רואה את שלו
create policy drive_files_select on public.drive_files for select to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- folders (מחיקה = עדכון deleted=true; אין DELETE מהלקוח)
create policy folders_select on public.folders for select to authenticated using (public.folder_visible(id));
create policy folders_insert on public.folders for insert to authenticated
  with check (created_by = auth.uid() and public.can_upload(parent_id, null));
create policy folders_update on public.folders for update to authenticated
  using (public.folder_level(id) >= 3)
  with check (public.folder_level(id) >= 3);

-- plans
create policy plans_select on public.plans for select to authenticated using (public.plan_level(id) >= 1);
create policy plans_insert on public.plans for insert to authenticated
  with check (created_by = auth.uid() and public.can_upload(folder_id, null));
create policy plans_update on public.plans for update to authenticated
  using (public.plan_level(id) >= 3)
  with check (public.plan_level(id) >= 3);

-- versions
create policy versions_select on public.versions for select to authenticated using (public.plan_level(plan_id) >= 1);
create policy versions_insert on public.versions for insert to authenticated
  with check (
    created_by = auth.uid() and public.plan_level(plan_id) >= 3
    and exists (select 1 from public.drive_files d where d.file_id = drive_file_id and d.created_by = auth.uid())
  );
create policy versions_update on public.versions for update to authenticated
  using (public.plan_level(plan_id) >= 3) with check (public.plan_level(plan_id) >= 3);

-- items: עובד רואה/עורך את שלו (לפי רמה); עריכה מלאה ומנהל – את הכול. כיולים וקישורים משותפים לכל מי שרואה את התוכנית.
create policy items_select on public.items for select to authenticated
  using (
    public.plan_level(plan_id) >= 1
    and (kind in ('calibrations','links') or owner_id = auth.uid() or public.plan_level(plan_id) >= 3)
  );
create policy items_insert on public.items for insert to authenticated
  with check (
    (kind in ('markups','measurements') and owner_id = auth.uid() and public.plan_level(plan_id) >= 2)
    or public.plan_level(plan_id) >= 3
  );
create policy items_update on public.items for update to authenticated
  using (
    (kind in ('markups','measurements') and owner_id = auth.uid() and public.plan_level(plan_id) >= 2)
    or public.plan_level(plan_id) >= 3
  )
  with check (
    (kind in ('markups','measurements') and public.plan_level(plan_id) >= 2)
    or public.plan_level(plan_id) >= 3
  );

-- ---------- הרשאות API ----------
revoke all on public.profiles, public.folders, public.plans, public.versions, public.items, public.drive_files, public.grants from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.folders, public.plans, public.versions, public.items to authenticated;
grant select on public.drive_files to authenticated;
grant select, insert, update, delete on public.grants to authenticated;
grant execute on function public.ping() to anon, authenticated;
grant execute on function public.can_upload(text, text) to authenticated;
revoke execute on function public.is_admin(), public.folder_level(text), public.plan_level(text), public.folder_visible(text) from public;
grant execute on function public.is_admin(), public.folder_level(text), public.plan_level(text), public.folder_visible(text) to authenticated;

-- ---------- Realtime (עדכון חי) ----------
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['folders','plans','versions','items','grants'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;

-- ---------- הפיכת משתמש למנהל (מריצים פעם אחת, עם האימייל שלך) ----------
-- update public.profiles set role = 'admin' where email = 'YOUR_EMAIL@example.com';

-- CP-12: owners/admins must keep full category/group visibility for management.
-- SEC-03 only bypassed role = 'owner', so admins with a permissions row lost
-- SELECT on hidden categories/groups; Supabase UPDATEs then match 0 rows (silent).
-- Settings toggles (visible_category_ids) also need managers to read all categories.

create or replace function public.can_access_family_module(target_family_id uuid, module_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  member_role text;
  perms public.family_member_permissions;
begin
  if target_family_id is null then
    return false;
  end if;

  member_role := public.my_family_role(target_family_id);
  if member_role is null then
    return false;
  end if;

  -- Household managers are unrestricted (configure member views in settings).
  if member_role in ('owner', 'admin') then
    return true;
  end if;

  perms := public.my_family_permissions(target_family_id);
  if perms is null then
    return true;
  end if;

  if module_id = 'settings' then
    return false;
  end if;

  if module_id = 'investments' and perms.show_investments is false then
    return false;
  end if;

  if perms.allowed_modules is null then
    return true;
  end if;

  return module_id = any (perms.allowed_modules);
end;
$$;

create or replace function public.can_view_family_category(
  target_family_id uuid,
  target_category_id uuid,
  category_created_at timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  member_role text;
  perms public.family_member_permissions;
  masked jsonb;
  permissions_updated_at timestamptz;
begin
  if target_family_id is null then
    return true;
  end if;

  if target_category_id is null then
    return true;
  end if;

  member_role := public.my_family_role(target_family_id);
  if member_role is null then
    return false;
  end if;

  if member_role in ('owner', 'admin') then
    return true;
  end if;

  perms := public.my_family_permissions(target_family_id);
  if perms is null then
    return true;
  end if;

  masked := perms.masked_category_amounts;
  if masked is not null
     and masked ? target_category_id::text
     and nullif(masked ->> target_category_id::text, '') is not null then
    return false;
  end if;

  if perms.visible_category_ids is null then
    return true;
  end if;

  if target_category_id = any (perms.visible_category_ids) then
    return true;
  end if;

  permissions_updated_at := coalesce(perms.updated_at, perms.created_at);
  if category_created_at is not null and permissions_updated_at is not null then
    return category_created_at > permissions_updated_at;
  end if;

  return false;
end;
$$;

-- Defense in depth: managers can always SELECT/UPDATE family catalog rows even if a
-- future visibility helper regresses. Policies are OR'd with existing owner policies.
drop policy if exists "categories family managers select" on public.categories;
create policy "categories family managers select"
on public.categories
for select
to authenticated
using (
  family_id is not null
  and public.can_manage_family_members(family_id)
);

drop policy if exists "groups family managers select" on public.groups;
create policy "groups family managers select"
on public.groups
for select
to authenticated
using (
  family_id is not null
  and public.can_manage_family_members(family_id)
);

-- Ensure UPDATE USING can see manager-targeted rows (silent 0-row updates otherwise).
drop policy if exists "categories family managers update" on public.categories;
create policy "categories family managers update"
on public.categories
for update
to authenticated
using (
  family_id is not null
  and public.can_manage_family_members(family_id)
)
with check (
  family_id is not null
  and public.can_manage_family_members(family_id)
);

drop policy if exists "groups family managers update" on public.groups;
create policy "groups family managers update"
on public.groups
for update
to authenticated
using (
  family_id is not null
  and public.can_manage_family_members(family_id)
)
with check (
  family_id is not null
  and public.can_manage_family_members(family_id)
);

-- CP-12 follow-up: enabling a category in Settings must make it readable to the member.
--
-- SEC-03 treated masked_category_amounts as non-readable, which contradicted the
-- Settings UX ("monto que verá el miembro") and made visibility toggles inert whenever
-- a mask existed (common for income like Monotributo).
--
-- Visibility is controlled only by visible_category_ids (and role/module gates).
-- Masks remain a presentation substitute for amounts on the client.
--
-- Also: categories SELECT required module 'categories', so members with only
-- transactions/dashboard could not read category rows/embeds for enabled ids.

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

  -- Masks do not hide the category; they only substitute amounts in the app layer.
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

-- Category catalog rows: membership + category visibility (no categories-module gate).
-- Module 'categories' still gates the Categorías nav in the client.
drop policy if exists "categories owner select" on public.categories;
create policy "categories owner select"
on public.categories
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    family_id is not null
    and public.is_family_member(family_id)
    and public.can_view_family_category(family_id, id, created_at)
  )
);

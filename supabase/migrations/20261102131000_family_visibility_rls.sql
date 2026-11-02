-- SEC-03: enforce family module/category visibility in RLS (not only UI).
-- Owners and members without a permissions row remain unrestricted.
-- Masked categories are treated as non-readable for the restricted member
-- (stricter than UI placeholders; prevents amount exfiltration via direct SELECT).

create or replace function public.my_family_permissions(target_family_id uuid)
returns public.family_member_permissions
language sql
stable
security definer
set search_path = public
as $$
  select fmp.*
  from public.family_member_permissions fmp
  join public.family_members fm on fm.id = fmp.family_member_id
  where fmp.family_id = target_family_id
    and fmp.user_id = auth.uid()
    and fm.user_id = auth.uid()
    and fm.family_id = target_family_id
    and fm.is_active = true
  limit 1;
$$;

create or replace function public.my_family_role(target_family_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select fm.role
  from public.family_members fm
  where fm.family_id = target_family_id
    and fm.user_id = auth.uid()
    and fm.is_active = true
  limit 1;
$$;

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

  -- Owners are never restricted by module permissions.
  if member_role = 'owner' then
    return true;
  end if;

  perms := public.my_family_permissions(target_family_id);
  -- No permissions row => unrestricted (matches client canApplyFamilyRestrictions).
  if perms is null then
    return true;
  end if;

  if module_id = 'settings' and member_role not in ('owner', 'admin') then
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

  if member_role = 'owner' then
    return true;
  end if;

  perms := public.my_family_permissions(target_family_id);
  if perms is null then
    return true;
  end if;

  -- Masked categories are not readable via direct table SELECT for restricted members.
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

create or replace function public.can_read_family_row(
  target_family_id uuid,
  module_id text,
  target_category_id uuid default null,
  category_created_at timestamptz default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    target_family_id is not null
    and public.is_family_member(target_family_id)
    and public.can_access_family_module(target_family_id, module_id)
    and public.can_view_family_category(target_family_id, target_category_id, category_created_at);
$$;

revoke all on function public.my_family_permissions(uuid) from public;
revoke all on function public.my_family_role(uuid) from public;
revoke all on function public.can_access_family_module(uuid, text) from public;
revoke all on function public.can_view_family_category(uuid, uuid, timestamptz) from public;
revoke all on function public.can_read_family_row(uuid, text, uuid, timestamptz) from public;

grant execute on function public.my_family_permissions(uuid) to authenticated;
grant execute on function public.my_family_role(uuid) to authenticated;
grant execute on function public.can_access_family_module(uuid, text) to authenticated;
grant execute on function public.can_view_family_category(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.can_read_family_row(uuid, text, uuid, timestamptz) to authenticated;

-- Replace broad ALL policies with module-aware SELECT + existing write checks.
do $$
declare
  rec record;
begin
  for rec in
    select *
    from (values
      ('groups', 'categories', false),
      ('categories', 'categories', true),
      ('credit_cards', 'credit_cards', false),
      ('credit_card_purchases', 'credit_cards', false),
      ('transactions', 'transactions', true),
      ('budgets', 'transactions', true),
      ('investments', 'investments', false),
      ('savings_goals', 'savings', false),
      ('savings_movements', 'savings', false),
      ('monthly_savings', 'savings', false)
    ) as t(table_name, module_id, has_category)
  loop
    execute format('drop policy if exists %I on public.%I', rec.table_name || ' owner access', rec.table_name);

    if rec.has_category then
      execute format(
        $policy$
          create policy %I on public.%I
          for select to authenticated
          using (
            user_id = auth.uid()
            or public.can_read_family_row(family_id, %L, category_id, null)
          )
        $policy$,
        rec.table_name || ' owner select',
        rec.table_name,
        rec.module_id
      );
    else
      execute format(
        $policy$
          create policy %I on public.%I
          for select to authenticated
          using (
            user_id = auth.uid()
            or (
              family_id is not null
              and public.is_family_member(family_id)
              and public.can_access_family_module(family_id, %L)
            )
          )
        $policy$,
        rec.table_name || ' owner select',
        rec.table_name,
        rec.module_id
      );
    end if;

    execute format(
      $policy$
        create policy %I on public.%I
        for insert to authenticated
        with check (
          user_id = auth.uid()
          or (family_id is not null and public.can_edit_family(family_id))
        )
      $policy$,
      rec.table_name || ' owner insert',
      rec.table_name
    );

    execute format(
      $policy$
        create policy %I on public.%I
        for update to authenticated
        using (
          user_id = auth.uid()
          or (family_id is not null and public.can_edit_family(family_id))
        )
        with check (
          user_id = auth.uid()
          or (family_id is not null and public.can_edit_family(family_id))
        )
      $policy$,
      rec.table_name || ' owner update',
      rec.table_name
    );

    execute format(
      $policy$
        create policy %I on public.%I
        for delete to authenticated
        using (
          user_id = auth.uid()
          or (family_id is not null and public.can_edit_family(family_id))
        )
      $policy$,
      rec.table_name || ' owner delete',
      rec.table_name
    );
  end loop;
end $$;

-- Categories need created_at-aware visibility; refine SELECT using row created_at.
drop policy if exists "categories owner select" on public.categories;
create policy "categories owner select"
on public.categories
for select
to authenticated
using (
  user_id = auth.uid()
  or public.can_read_family_row(family_id, 'categories', id, created_at)
);

-- Helper to attach insert/update/delete policies without SELECT (avoids bypassing module RLS).
create or replace function public._tmp_add_family_write_policies(target_table text)
returns void
language plpgsql
as $$
begin
  execute format(
    $policy$
      create policy %I on public.%I
      for insert to authenticated
      with check (
        user_id = auth.uid()
        or (family_id is not null and public.can_edit_family(family_id))
      )
    $policy$,
    target_table || ' owner insert',
    target_table
  );
  execute format(
    $policy$
      create policy %I on public.%I
      for update to authenticated
      using (
        user_id = auth.uid()
        or (family_id is not null and public.can_edit_family(family_id))
      )
      with check (
        user_id = auth.uid()
        or (family_id is not null and public.can_edit_family(family_id))
      )
    $policy$,
    target_table || ' owner update',
    target_table
  );
  execute format(
    $policy$
      create policy %I on public.%I
      for delete to authenticated
      using (
        user_id = auth.uid()
        or (family_id is not null and public.can_edit_family(family_id))
      )
    $policy$,
    target_table || ' owner delete',
    target_table
  );
end;
$$;

-- Recurring income templates
drop policy if exists "recurring_income_templates owner access" on public.recurring_income_templates;
create policy "recurring_income_templates owner select"
on public.recurring_income_templates
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    family_id is not null
    and public.is_family_member(family_id)
    and public.can_access_family_module(family_id, 'transactions')
  )
);
select public._tmp_add_family_write_policies('recurring_income_templates');

-- Projection / closures
drop policy if exists "projection scenarios owner access" on public.projection_scenarios;
create policy "projection scenarios owner select"
on public.projection_scenarios
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    family_id is not null
    and public.is_family_member(family_id)
    and public.can_access_family_module(family_id, 'projections')
  )
);
select public._tmp_add_family_write_policies('projection_scenarios');

drop policy if exists "projection scenario items owner access" on public.projection_scenario_items;
create policy "projection scenario items owner select"
on public.projection_scenario_items
for select
to authenticated
using (
  exists (
    select 1
    from public.projection_scenarios scenario
    where scenario.id = projection_scenario_items.scenario_id
      and (
        scenario.user_id = auth.uid()
        or (
          scenario.family_id is not null
          and public.is_family_member(scenario.family_id)
          and public.can_access_family_module(scenario.family_id, 'projections')
        )
      )
  )
);
create policy "projection scenario items owner insert"
on public.projection_scenario_items
for insert
to authenticated
with check (
  exists (
    select 1
    from public.projection_scenarios scenario
    where scenario.id = projection_scenario_items.scenario_id
      and (
        scenario.user_id = auth.uid()
        or (scenario.family_id is not null and public.can_edit_family(scenario.family_id))
      )
  )
);
create policy "projection scenario items owner update"
on public.projection_scenario_items
for update
to authenticated
using (
  exists (
    select 1
    from public.projection_scenarios scenario
    where scenario.id = projection_scenario_items.scenario_id
      and (
        scenario.user_id = auth.uid()
        or (scenario.family_id is not null and public.can_edit_family(scenario.family_id))
      )
  )
)
with check (
  exists (
    select 1
    from public.projection_scenarios scenario
    where scenario.id = projection_scenario_items.scenario_id
      and (
        scenario.user_id = auth.uid()
        or (scenario.family_id is not null and public.can_edit_family(scenario.family_id))
      )
  )
);
create policy "projection scenario items owner delete"
on public.projection_scenario_items
for delete
to authenticated
using (
  exists (
    select 1
    from public.projection_scenarios scenario
    where scenario.id = projection_scenario_items.scenario_id
      and (
        scenario.user_id = auth.uid()
        or (scenario.family_id is not null and public.can_edit_family(scenario.family_id))
      )
  )
);

drop policy if exists "monthly closures owner access" on public.monthly_closures;
create policy "monthly closures owner select"
on public.monthly_closures
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    family_id is not null
    and public.is_family_member(family_id)
    and public.can_access_family_module(family_id, 'projections')
  )
);
select public._tmp_add_family_write_policies('monthly_closures');

-- Credit card statements
drop policy if exists "credit card statements owner access" on public.credit_card_statements;
create policy "credit card statements owner select"
on public.credit_card_statements
for select
to authenticated
using (
  user_id = auth.uid()
  or (
    family_id is not null
    and public.is_family_member(family_id)
    and public.can_access_family_module(family_id, 'credit_cards')
  )
);
select public._tmp_add_family_write_policies('credit_card_statements');

drop function if exists public._tmp_add_family_write_policies(text);

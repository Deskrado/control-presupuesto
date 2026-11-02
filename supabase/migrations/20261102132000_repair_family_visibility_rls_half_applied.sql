-- Repair half-applied SEC-03 RLS from a failed 20261102131000 run.
-- Safe if 31000 already completed successfully (idempotent DROP/CREATE).
--
-- Prod failure: CREATE POLICY on budgets referenced category_id (SQLSTATE 42703).
-- Tables processed before budgets may already have new owner select/insert/update/delete
-- policies while budgets/investments/... still have legacy "owner access" (or none).

create or replace function public._family_visibility_table_has_column(target_table text, target_column text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = target_table
      and c.column_name = target_column
  );
$$;

create or replace function public._family_visibility_drop_owner_policies(target_table text)
returns void
language plpgsql
set search_path = public
as $$
begin
  execute format('drop policy if exists %I on public.%I', target_table || ' owner access', target_table);
  execute format('drop policy if exists %I on public.%I', target_table || ' owner select', target_table);
  execute format('drop policy if exists %I on public.%I', target_table || ' owner insert', target_table);
  execute format('drop policy if exists %I on public.%I', target_table || ' owner update', target_table);
  execute format('drop policy if exists %I on public.%I', target_table || ' owner delete', target_table);
  execute format('drop policy if exists %I on public.%I', target_table || ' owner write', target_table);
end;
$$;

create or replace function public._family_visibility_add_write_policies(target_table text)
returns void
language plpgsql
set search_path = public
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

-- Ensure helper predicates exist (no-op replace if 31000 already created them).
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

  select fm.role into member_role
  from public.family_members fm
  where fm.family_id = target_family_id
    and fm.user_id = auth.uid()
    and fm.is_active = true
  limit 1;

  if member_role is null then
    return false;
  end if;

  if member_role = 'owner' then
    return true;
  end if;

  select fmp.* into perms
  from public.family_member_permissions fmp
  join public.family_members fm on fm.id = fmp.family_member_id
  where fmp.family_id = target_family_id
    and fmp.user_id = auth.uid()
    and fm.user_id = auth.uid()
    and fm.family_id = target_family_id
    and fm.is_active = true
  limit 1;

  if not found then
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
  if target_family_id is null or target_category_id is null then
    return true;
  end if;

  select fm.role into member_role
  from public.family_members fm
  where fm.family_id = target_family_id
    and fm.user_id = auth.uid()
    and fm.is_active = true
  limit 1;

  if member_role is null then
    return false;
  end if;

  if member_role = 'owner' then
    return true;
  end if;

  select fmp.* into perms
  from public.family_member_permissions fmp
  join public.family_members fm on fm.id = fmp.family_member_id
  where fmp.family_id = target_family_id
    and fmp.user_id = auth.uid()
    and fm.user_id = auth.uid()
    and fm.family_id = target_family_id
    and fm.is_active = true
  limit 1;

  if not found then
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

grant execute on function public.can_access_family_module(uuid, text) to authenticated;
grant execute on function public.can_view_family_category(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.can_read_family_row(uuid, text, uuid, timestamptz) to authenticated;

do $$
declare
  rec record;
  has_category_id boolean;
begin
  for rec in
    select *
    from (values
      ('groups', 'categories'),
      ('categories', 'categories'),
      ('credit_cards', 'credit_cards'),
      ('credit_card_purchases', 'credit_cards'),
      ('transactions', 'transactions'),
      ('budgets', 'transactions'),
      ('investments', 'investments'),
      ('savings_goals', 'savings'),
      ('savings_movements', 'savings'),
      ('monthly_savings', 'savings'),
      ('recurring_income_templates', 'transactions'),
      ('projection_scenarios', 'projections'),
      ('monthly_closures', 'projections'),
      ('credit_card_statements', 'credit_cards')
    ) as t(table_name, module_id)
  loop
    if to_regclass(format('public.%I', rec.table_name)) is null then
      continue;
    end if;

    perform public._family_visibility_drop_owner_policies(rec.table_name);
    has_category_id := public._family_visibility_table_has_column(rec.table_name, 'category_id');

    if rec.table_name = 'categories' then
      execute format(
        $policy$
          create policy %I on public.%I
          for select to authenticated
          using (
            user_id = auth.uid()
            or public.can_read_family_row(family_id, %L, id, created_at)
          )
        $policy$,
        rec.table_name || ' owner select',
        rec.table_name,
        rec.module_id
      );
    elsif has_category_id then
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

    perform public._family_visibility_add_write_policies(rec.table_name);
  end loop;
end $$;

-- projection_scenario_items (no user_id/family_id on the row itself)
drop policy if exists "projection scenario items owner access" on public.projection_scenario_items;
drop policy if exists "projection scenario items owner select" on public.projection_scenario_items;
drop policy if exists "projection scenario items owner insert" on public.projection_scenario_items;
drop policy if exists "projection scenario items owner update" on public.projection_scenario_items;
drop policy if exists "projection scenario items owner delete" on public.projection_scenario_items;
drop policy if exists "projection scenario items owner write" on public.projection_scenario_items;

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

drop function if exists public._family_visibility_add_write_policies(text);
drop function if exists public._family_visibility_drop_owner_policies(text);
drop function if exists public._family_visibility_table_has_column(text, text);
drop function if exists public._tmp_add_family_write_policies(text);

-- One monthly closure per family period (not per member). Personal users
-- without family_id keep uniqueness on (user_id, year, month).

alter table public.monthly_closures
  drop constraint if exists monthly_closures_user_id_year_month_key;

-- Keep the newest family closure when duplicates already exist.
with ranked as (
  select
    id,
    row_number() over (
      partition by family_id, year, month
      order by closed_at desc nulls last, created_at desc nulls last, id desc
    ) as rn
  from public.monthly_closures
  where family_id is not null
)
delete from public.monthly_closures
where id in (select id from ranked where rn > 1);

create unique index if not exists idx_monthly_closures_family_period_unique
  on public.monthly_closures (family_id, year, month)
  where family_id is not null;

create unique index if not exists idx_monthly_closures_user_personal_period_unique
  on public.monthly_closures (user_id, year, month)
  where family_id is null;

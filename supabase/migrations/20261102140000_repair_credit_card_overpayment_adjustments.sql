-- Repair adjustments created by 20260601124000_backfill_credit_card_overpayment_adjustments.sql.
-- That backfill used (paid - expected) when paid > expected, ignoring previous_balance /
-- amount_due. App logic is adjustment = max(0, paid - amount_due).

-- 1) Archive false positives and wrong-magnitude rows that should not exist
--    (correct adjustment amount is 0).
update public.transactions as adjustment
set
  archived_at = coalesce(adjustment.archived_at, now()),
  metadata = coalesce(adjustment.metadata, '{}'::jsonb) || jsonb_build_object(
    'repair_source', '20261102140000_repair_credit_card_overpayment_adjustments',
    'repaired_at', now(),
    'repair_action', 'archive_zero_adjustment'
  )
from public.credit_card_statements as statement
where adjustment.archived_at is null
  and adjustment.metadata @> jsonb_build_object(
    'source', 'credit_card_statement_payment_adjustment',
    'credit_card_statement_id', statement.id
  )
  and statement.status = 'paid'
  and round(greatest(0, statement.paid_amount - statement.amount_due)::numeric, 2) <= 0.009;

-- 2) Correct amounts for adjustments that should remain.
update public.transactions as adjustment
set
  amount = round((statement.paid_amount - statement.amount_due)::numeric, 2),
  budgeted_amount = round((statement.paid_amount - statement.amount_due)::numeric, 2),
  metadata = coalesce(adjustment.metadata, '{}'::jsonb) || jsonb_build_object(
    'expected_amount', statement.expected_amount,
    'paid_amount', statement.paid_amount,
    'previous_balance', statement.previous_balance,
    'amount_due', statement.amount_due,
    'adjustment_kind', case
      when statement.paid_amount > statement.amount_due then 'overpayment'
      else 'previous_balance_payment'
    end,
    'repair_source', '20261102140000_repair_credit_card_overpayment_adjustments',
    'repaired_at', now(),
    'repair_action', 'correct_amount'
  )
from public.credit_card_statements as statement
where adjustment.archived_at is null
  and adjustment.metadata @> jsonb_build_object(
    'source', 'credit_card_statement_payment_adjustment',
    'credit_card_statement_id', statement.id
  )
  and statement.status = 'paid'
  and round(greatest(0, statement.paid_amount - statement.amount_due)::numeric, 2) > 0.009
  and adjustment.amount is distinct from round((statement.paid_amount - statement.amount_due)::numeric, 2);

-- 3) Insert missing adjustments where paid > amount_due and none exist (live).
insert into public.transactions (
  user_id,
  family_id,
  created_by,
  description,
  amount,
  budgeted_amount,
  currency_id,
  category_id,
  group_id,
  transaction_date,
  type,
  is_recurring,
  payment_method,
  credit_card_id,
  credit_card_purchase_id,
  installment_number,
  status,
  approved_at,
  approved_by,
  notes,
  metadata
)
select
  statement.user_id,
  statement.family_id,
  statement.approved_by,
  'Ajuste pago ' || card.name,
  round((statement.paid_amount - statement.amount_due)::numeric, 2),
  round((statement.paid_amount - statement.amount_due)::numeric, 2),
  statement.currency_id,
  null,
  null,
  make_date(
    statement.year,
    statement.month,
    least(
      coalesce(card.due_day, 1),
      extract(day from (date_trunc('month', make_date(statement.year, statement.month, 1)) + interval '1 month - 1 day'))::integer
    )
  ),
  'expense',
  false,
  'credit',
  statement.credit_card_id,
  null,
  null,
  'approved',
  coalesce(statement.approved_at, now()),
  statement.approved_by,
  null,
  jsonb_build_object(
    'source', 'credit_card_statement_payment_adjustment',
    'credit_card_statement_id', statement.id,
    'expected_amount', statement.expected_amount,
    'paid_amount', statement.paid_amount,
    'previous_balance', statement.previous_balance,
    'amount_due', statement.amount_due,
    'adjustment_kind', case
      when statement.paid_amount > statement.amount_due then 'overpayment'
      else 'previous_balance_payment'
    end,
    'repair_source', '20261102140000_repair_credit_card_overpayment_adjustments',
    'repaired_at', now(),
    'repair_action', 'insert_missing'
  )
from public.credit_card_statements as statement
join public.credit_cards as card on card.id = statement.credit_card_id
where statement.status = 'paid'
  and round(greatest(0, statement.paid_amount - statement.amount_due)::numeric, 2) > 0.009
  and not exists (
    select 1
    from public.transactions as existing
    where existing.archived_at is null
      and existing.metadata @> jsonb_build_object(
        'source', 'credit_card_statement_payment_adjustment',
        'credit_card_statement_id', statement.id
      )
  );

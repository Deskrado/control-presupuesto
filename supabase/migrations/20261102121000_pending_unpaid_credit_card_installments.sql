-- Installment rows are debt until the statement is paid. Undo the
-- 20260817 blanket approval for periods that still have no paid statement,
-- so dashboard cash only moves on "Confirmar pago".
update public.transactions transaction
set
  status = 'pending',
  approved_at = null,
  approved_by = null,
  updated_at = now(),
  metadata = coalesce(transaction.metadata, '{}'::jsonb) || jsonb_build_object(
    'installment_cashflow_semantics', jsonb_build_object(
      'changed_at', now(),
      'reason', 'credit_card_installments_pending_until_statement_payment'
    )
  )
where transaction.archived_at is null
  and transaction.type = 'expense'
  and transaction.payment_method = 'credit'
  and transaction.credit_card_purchase_id is not null
  and transaction.installment_number is not null
  and transaction.status = 'approved'
  and transaction.transaction_date >= date '2026-06-01'
  and not exists (
    select 1
    from public.credit_card_statements statement
    where statement.credit_card_id = transaction.credit_card_id
      and statement.year = extract(year from transaction.transaction_date)::integer
      and statement.month = extract(month from transaction.transaction_date)::integer
      and statement.status = 'paid'
  );

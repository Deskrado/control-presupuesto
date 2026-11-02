# Deploy y migraciones

El deploy de producción es Vercel (merge a `main` / v0). El script `build` aplica migraciones **solo** en builds de producción y luego corre `next build`.

## Flujo

1. Vercel ejecuta `pnpm build` → `scripts/migrate-on-deploy.mjs` → `next build`.
2. `migrate-on-deploy` llama a `pnpm db:migrate` (`scripts/supabase-migrate.mjs push`) únicamente si:
   - `VERCEL_ENV=production`, o
   - `RUN_DB_MIGRATE=1` (forzar, p. ej. smoke local/CI).
3. Preview builds, Development y `pnpm build` local **no** migran (evita tocar prod desde cada PR).

Las migraciones viven en `supabase/migrations`.

## Variables de entorno (Vercel Production)

| Variable | Obligatoria | Notas |
|----------|-------------|--------|
| `POSTGRES_URL_NON_POOLING` | Preferida | Connection string directa (no pooler). Mejor para DDL/`supabase db push`. |
| `POSTGRES_URL` | Alternativa | Usada si no hay `POSTGRES_URL_NON_POOLING`. |

Configurarlas en Vercel → Project → Settings → Environment Variables, scope **Production** only (no Preview), salvo que tengas un Postgres de preview dedicado.

Sin una de esas URLs, el build de producción falla a propósito para no desplegar schema desfasado.

El resto de vars de la app (`NEXT_PUBLIC_SUPABASE_*`, etc.) no cambian con este flujo.

## Manual / local

```bash
# Aplicar migraciones a la DB remota (usa .env o el entorno)
pnpm db:migrate

# Dry-run
pnpm db:migrate:dry-run

# Forzar el mismo path que producción sin Vercel
RUN_DB_MIGRATE=1 pnpm build
```

## Riesgos residuales

- Un migrate fallido **bloquea** el deploy (intencional). Revisar logs del build de Vercel.
- Migraciones no idempotentes o destructivas siguen siendo peligrosas: el gate solo limita *cuándo* corren, no audita el SQL.
- Si Preview comparte la misma URL de Postgres, no marques esas vars para Preview.
- El CLI de Supabase se resuelve con `npx -y supabase` en el build; un outage de npm puede fallar el migrate.
- `supabase-migrate.mjs` pasa `--yes` (CI no es TTY) y usa `--remote=<url>` / `--remote` (CLI 3.x; reemplaza `--db-url` / `--linked`).

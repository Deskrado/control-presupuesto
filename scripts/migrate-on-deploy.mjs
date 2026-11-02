import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

/**
 * Runs `db:migrate` only on production deploys (or when forced).
 *
 * Why gate:
 * - Vercel preview builds also run `pnpm build`; production DB URLs must not
 *   be applied from every PR preview.
 * - Local `pnpm build` stays offline-friendly without Postgres secrets.
 *
 * Force (CI/smoke): RUN_DB_MIGRATE=1
 */
const vercelEnv = process.env.VERCEL_ENV
const force = process.env.RUN_DB_MIGRATE === "1"
const shouldMigrate = force || vercelEnv === "production"

if (!shouldMigrate) {
  console.log(
    `[migrate-on-deploy] Skipping migrations (VERCEL_ENV=${vercelEnv ?? "unset"}). ` +
      "Runs only when VERCEL_ENV=production or RUN_DB_MIGRATE=1.",
  )
  process.exit(0)
}

const dbUrl = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL
if (!dbUrl) {
  console.error(
    "[migrate-on-deploy] Missing database URL for migrations.\n" +
      "Set POSTGRES_URL_NON_POOLING (preferred for DDL) or POSTGRES_URL " +
      "in Vercel → Project → Settings → Environment Variables → Production.",
  )
  process.exit(1)
}

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "supabase-migrate.mjs")
console.log(
  `[migrate-on-deploy] Applying supabase/migrations via db:migrate ` +
    `(${force ? "RUN_DB_MIGRATE=1" : "VERCEL_ENV=production"})…`,
)

const result = spawnSync(process.execPath, [scriptPath, "push"], {
  stdio: "inherit",
  env: process.env,
})

if (result.error) {
  console.error("[migrate-on-deploy] Failed to start migrate script:", result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)

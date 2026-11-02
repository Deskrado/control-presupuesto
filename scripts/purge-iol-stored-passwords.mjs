#!/usr/bin/env node
/**
 * SEC-02 cleanup: re-encrypt IOL integration_secrets without legacy password fields.
 *
 * Usage (server/ops only):
 *   INTEGRATIONS_ENCRYPTION_KEY=... SUPABASE_SERVICE_ROLE_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     node scripts/purge-iol-stored-passwords.mjs [--dry-run]
 *
 * Requires the same INTEGRATIONS_ENCRYPTION_KEY used to encrypt existing secrets.
 * Rotate the key separately if it may have been exposed.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

function loadEnvFile() {
  for (const name of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), name)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const idx = trimmed.indexOf("=")
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx)
      let value = trimmed.slice(idx + 1)
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!(key in process.env)) process.env[key] = value
    }
  }
}

loadEnvFile()

const dryRun = process.argv.includes("--dry-run")
const ALGORITHM = "aes-256-gcm"

function getKey() {
  const rawKey = process.env.INTEGRATIONS_ENCRYPTION_KEY
  if (!rawKey) throw new Error("Falta INTEGRATIONS_ENCRYPTION_KEY")
  if (/^[a-f0-9]{64}$/i.test(rawKey)) return Buffer.from(rawKey, "hex")
  try {
    const decoded = Buffer.from(rawKey, "base64")
    if (decoded.length === 32) return decoded
  } catch {
    // fall through
  }
  return createHash("sha256").update(rawKey).digest()
}

function decryptJson(encrypted) {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(encrypted.iv, "base64"))
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8")
  return JSON.parse(plaintext)
}

function encryptJson(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()])
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    key_version: "v1",
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceRoleKey) {
  throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY")
}

const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } })
const { data: secrets, error } = await admin
  .from("integration_secrets")
  .select("id, provider_code, ciphertext, iv, tag, key_version")
  .eq("provider_code", "iol")

if (error) throw error

let scanned = 0
let withPassword = 0
let updated = 0

for (const secret of secrets || []) {
  scanned += 1
  let payload
  try {
    payload = decryptJson(secret)
  } catch (decryptError) {
    console.error(`No se pudo descifrar secret ${secret.id}:`, decryptError.message || decryptError)
    continue
  }

  if (!payload || typeof payload.password !== "string" || !payload.password) continue
  withPassword += 1

  const { password: _password, ...rest } = payload
  console.log(`${dryRun ? "[dry-run] " : ""}Purgando password de secret ${secret.id}`)
  if (dryRun) continue

  const { error: updateError } = await admin
    .from("integration_secrets")
    .update(encryptJson(rest))
    .eq("id", secret.id)

  if (updateError) throw updateError
  updated += 1
}

console.log(JSON.stringify({ scanned, withPassword, updated, dryRun }, null, 2))

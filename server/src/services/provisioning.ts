/**
 * Creating a company and its first owner.
 *
 * Two routes need this — `/auth/signup`, which anyone may call on a hosted
 * instance, and `/setup`, which the first-run installer calls exactly once on a
 * self-hosted one. They differ entirely in who is allowed to call them and not
 * at all in what gets created, so the "what" lives here. When it was duplicated,
 * the obvious way for it to rot was for one path to gain a default calendar and
 * the other not to — and a company without a calendar cannot schedule anything,
 * so that is a broken install with a working login.
 */

import bcrypt from 'bcryptjs'
import type { PoolClient } from 'pg'
import { transaction } from '../db/pool.js'

export const BCRYPT_ROUNDS = 12

/** 3–40 characters, lowercase, no leading or trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export const MIN_PASSWORD_LENGTH = 8

export interface NewCompany {
  companyName: string
  slug: string
  email: string
  password: string
  name: string
}

export interface Provisioned {
  companyId: string
  userId: string
  slug: string
  tokenVersion: number
}

/** A validation failure with the message the caller should return verbatim. */
export class ProvisioningError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Normalise and check the input, or throw with the message to show the user.
 *
 * Separate from the insert so both routes reject bad input identically, and so
 * the rejection happens before a transaction is opened.
 */
export function validateNewCompany(input: Partial<NewCompany>): NewCompany {
  const { companyName, slug, email, password, name } = input

  if (!companyName || !slug || !email || !password || !name) {
    throw new ProvisioningError(
      400,
      'companyName, slug, email, password and name are required',
    )
  }

  const normalisedSlug = String(slug).toLowerCase().trim()
  if (!SLUG_PATTERN.test(normalisedSlug)) {
    throw new ProvisioningError(
      400,
      'Company code must be 3–40 characters, lowercase letters, numbers and hyphens',
    )
  }
  if (String(password).length < MIN_PASSWORD_LENGTH) {
    throw new ProvisioningError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    )
  }

  return {
    companyName: String(companyName).trim(),
    slug: normalisedSlug,
    email: String(email).toLowerCase().trim(),
    password: String(password),
    name: String(name).trim(),
  }
}

/**
 * Insert the company, its default calendar and its owner.
 *
 * Takes a client rather than opening its own transaction so `/setup` can hold
 * an advisory lock across the "is this the first company?" check and the insert.
 */
export async function insertCompanyWithOwner(
  client: PoolClient,
  input: NewCompany,
): Promise<Provisioned> {
  // Stringline is free: no trial, no expiry, no plan to upgrade to. The column
  // defaults carry plan='free' and status='active'.
  const company = await client.query<{ id: string }>(
    `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
    [input.companyName, input.slug],
  )
  const companyId = company.rows[0]!.id

  // Every company needs a calendar before it can hold a project.
  await client.query(
    `INSERT INTO calendars (company_id, name, working_weekdays, is_default)
     VALUES ($1, 'Standard week (Mon–Fri)', '{1,2,3,4,5}', TRUE)`,
    [companyId],
  )

  const hash = await bcrypt.hash(input.password, BCRYPT_ROUNDS)
  const user = await client.query<{ id: string; token_version: number }>(
    `INSERT INTO users (company_id, email, password_hash, name, role)
     VALUES ($1, $2, $3, $4, 'owner') RETURNING id, token_version`,
    [companyId, input.email, hash, input.name],
  )

  return {
    companyId,
    userId: user.rows[0]!.id,
    slug: input.slug,
    tokenVersion: user.rows[0]!.token_version,
  }
}

/** The common case: validate, then insert in its own transaction. */
export async function provisionCompany(input: Partial<NewCompany>): Promise<Provisioned> {
  const validated = validateNewCompany(input)
  return transaction((client) => insertCompanyWithOwner(client, validated))
}

/** Postgres raises this when the slug is taken. */
export function isDuplicateSlug(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505'
}

import type { Request } from 'express'

/**
 * Read a route parameter as a string.
 *
 * Express 5 types `req.params` values as `string | string[]`, because a route
 * pattern can bind a name more than once. None of ours do, so this narrows it
 * in one place instead of casting at every call site.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

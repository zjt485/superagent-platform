import { createHash } from 'node:crypto'
import type { ProjectPolicy } from '../domain/policy.js'

/** A stable identifier for the authorization/assessment rules a Mandate used. */
export function policyVersion(policy: ProjectPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16)
}

import { z } from 'zod'

/**
 * Per-project execution policy (FR-13, FR-10, FR-06). Stored as JSON so a
 * policy change does not need a migration, but validated on every write.
 */
export const projectPolicySchema = z.object({
  /** `required`: the plan needs a maintainer's approval before execution. */
  planApproval: z.enum(['required', 'auto']).default('auto'),
  /** Replies in an existing ticket thread may continue the ticket without @bot. */
  allowThreadReplies: z.boolean().default(true),
  /** How many runs of this project may execute at the same time. */
  maxConcurrentRuns: z.number().int().min(1).max(4).default(1),
  /** Daily token budget; 0 means "no budget" (still bounded by run timeout). */
  dailyTokenBudget: z.number().int().min(0).default(2_000_000),
  /** Hard limit for one agent run. */
  maxRunMinutes: z.number().int().min(1).max(180).default(45),
  /** Retry a failed run once, as allowed by §11.3. */
  retryOnFailure: z.boolean().default(true),
  /** PRs are never merged automatically; humans confirm the merge. */
  requireMergeApproval: z.boolean().default(true),
  /** Only `agent/*` branches may be pushed by the worker. */
  branchPrefix: z.string().min(1).max(64).default('agent/'),
  /** Viewers can read but never create tickets or run commands. */
  membersCanCreateTickets: z.boolean().default(true),
})

export type ProjectPolicy = z.infer<typeof projectPolicySchema>

export const DEFAULT_POLICY: ProjectPolicy = projectPolicySchema.parse({})

export const parsePolicy = (value: unknown): ProjectPolicy => {
  const parsed = projectPolicySchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : DEFAULT_POLICY
}

export const modelConfigSchema = z.object({
  provider: z.enum(['deepseek', 'openai', 'anthropic', 'custom']).default('deepseek'),
  model: z.string().min(1).default('deepseek-chat'),
  temperature: z.number().min(0).max(2).default(0.2),
})

export type ModelConfig = z.infer<typeof modelConfigSchema>
export const DEFAULT_MODEL_CONFIG: ModelConfig = modelConfigSchema.parse({})

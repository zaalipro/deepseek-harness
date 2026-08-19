/**
 * `session/workflow-runs` frame schema: the supervised-run view the dashboard
 * reads. Mirrors `@deepseek-ai/dsh-workflow-supervisor/types` as wire data.
 */

import { z } from 'zod'
import type { WorkflowPhase } from '@deepseek-ai/dsh-workflow/types'
import type { WorkflowRunStatus } from '@deepseek-ai/dsh-workflow-supervisor/types'
import type { Wire } from './rpc.schema.ts'

const phaseSchema = z.object({
  title: z.string().min(1),
  detail: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
}) satisfies z.ZodType<Wire<WorkflowPhase>>

const memberSchema = z.object({
  seq: z.number().int().positive(),
  label: z.string(),
  phase: z.string().optional(),
  status: z.union([z.literal('running'), z.literal('completed'), z.literal('failed'), z.literal('cancelled')]),
})

const gateSchema = z.object({
  kind: z.union([z.literal('user'), z.literal('back_off'), z.literal('no_progress'), z.literal('verification'), z.literal('infra')]),
  message: z.string(),
  resumable: z.boolean(),
})

const statusSchema = z.union([
  z.literal('running'),
  z.literal('needs-input'),
  z.literal('paused'),
  z.literal('completed'),
  z.literal('failed'),
  z.literal('cancelled'),
  z.literal('interrupted'),
]) satisfies z.ZodType<WorkflowRunStatus>

/** One wire supervised-run view carried by `session/workflow-runs` frames (schema only). */
export const workflowRunViewSchema = z.object({
  runId: z.string().min(1),
  displayName: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  status: statusSchema,
  phase: z.string().optional(),
  phases: z.array(phaseSchema).optional(),
  budget: z.object({ total: z.number().int().nonnegative(), spent: z.number().int().nonnegative(), remaining: z.number().int() }),
  members: z.array(memberSchema),
  logs: z.array(z.string()),
  result: z.unknown().optional(),
  error: z.string().optional(),
  gate: gateSchema.optional(),
  builtin: z.boolean(),
  numberedHandle: z.boolean(),
  scriptPath: z.string().optional(),
  startedAt: z.number(),
  settledAt: z.number().optional(),
})

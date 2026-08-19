import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as WorkflowUserQuestionsInvariant from '../src/invariant.ts'

describe('workflow-user-questions invariant companion', () => {
  it('removes its package registration when the plugin fiber unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(InvariantRegistry, { enabled: true })
      const fiber = await ctx.plugin(WorkflowUserQuestionsInvariant)

      expect(() => {
        ctx.invariants.register('@deepseek-ai/dsh-workflow-user-questions', () => {})
      }).toThrow(/already registered/u)

      await fiber.dispose()
      await expect(ctx.plugin(WorkflowUserQuestionsInvariant).await()).resolves.toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

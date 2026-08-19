import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as commandWorkflows from '../src/index.ts'

/** A stub definition registry whose catalog the test mutates. */
class StubWorkflows {
  definitions: { name: string; description: string }[] = []
  async list(): Promise<{ name: string; description: string }[]> {
    return this.definitions
  }
  async get(name: string): Promise<{ name: string; description: string; script: string; scope: 'project' } | undefined> {
    const found = this.definitions.find(definition => definition.name === name)
    return found === undefined ? undefined : { ...found, script: 'return 1', scope: 'project' }
  }
}

/** A supervisor stub: the refresh path never launches, so it stays inert. */
const supervisor = {
  start: () => { throw new Error('unexpected supervisor.start in command refresh test') },
  validate: () => { throw new Error('unexpected supervisor.validate') },
  resumeById: () => { throw new Error('unexpected supervisor.resumeById') },
  listRuns: () => [] as unknown[],
  pause: () => {},
  resume: () => {},
  stop: () => {},
  save: async (): Promise<string> => { throw new Error('unexpected supervisor.save') },
  markInterrupted: () => {},
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  const workflows = new StubWorkflows()
  ctx.provide('workflows', workflows)
  ctx.provide('workflowSupervisor', supervisor)
  await ctx.plugin(commandWorkflows, {})
  const session = Session.create(SessionId('caller'))
  const agent = { id: session.id, options: {}, session } as unknown as Agent
  return { ctx, workflows, agent }
}

describe('command-workflows registration', () => {
  it('registers the built-in commands and one launch command per saved name', async () => {
    const { ctx, workflows, agent } = await setup()
    await vi.waitFor(() => {
      const names = ctx.commands.list(agent).map(command => command.name)
      expect(names).toEqual(expect.arrayContaining(['workflow', 'workflows', 'create-workflow']))
    })
    workflows.definitions = [{ name: 'audit', description: 'review a diff' }]
    ctx.emit('workflows/change')
    await vi.waitFor(() => {
      const names = ctx.commands.list(agent).map(command => command.name)
      expect(names).toEqual(expect.arrayContaining(['audit']))
    })
  })

  it('yields the bare name to a built-in collision without stealing it', async () => {
    const { ctx, workflows, agent } = await setup()
    workflows.definitions = [{ name: 'workflow', description: 'a collision' }]
    ctx.emit('workflows/change')
    await vi.waitFor(() => {
      expect(ctx.commands.list(agent).map(command => command.name)).toContain('workflow')
    })
    // The built-in /workflow grammar command survives; the colliding definition
    // is NOT registered as a second bare /workflow (it failed quiet inside registerDefinition).
    const workflowDescriptors = ctx.commands.list(agent).filter(command => command.name === 'workflow')
    expect(workflowDescriptors).toHaveLength(1)
  })

  it('drops a definition command after the definition disappears on workflows/change', async () => {
    const { ctx, workflows, agent } = await setup()
    workflows.definitions = [{ name: 'gone', description: 'transient' }]
    ctx.emit('workflows/change')
    await vi.waitFor(() => {
      expect(ctx.commands.list(agent).map(command => command.name)).toContain('gone')
    })
    workflows.definitions = []
    ctx.emit('workflows/change')
    await vi.waitFor(() => {
      expect(ctx.commands.list(agent).map(command => command.name)).not.toContain('gone')
    })
  })

  it('registers the create-workflow skill as user-invocable', async () => {
    const { ctx } = await setup()
    const skills = await ctx.skills.list()
    const skill = skills.find(candidate => candidate.name === 'create-workflow')
    expect(skill).toBeDefined()
    expect(skill?.invocation.userInvocable).toBe(true)
    expect(skill?.description).toContain('/create-workflow')
  })
})

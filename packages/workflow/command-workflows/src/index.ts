/**
 * Workflow host commands: `/workflow` (launch/control grammar), `/workflows`
 * (open the run dashboard), `/create-workflow` (authoring skill entry), and one
 * launch command per saved definition name, refreshed on `workflows/change`.
 *
 * Launches are background and return the display handle; the run itself is
 * owned by `ctx.workflowSupervisor`. No internal run id ever reaches command
 * text — users pass display names to pause/resume/stop/save.
 * @module @deepseek-ai/dsh-command-workflows
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WorkflowDefinitionSummary } from '@deepseek-ai/dsh-workflow-registry'
// Type-only: resolves ctx.commands for the command registrations.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.skills for the bundled authoring skill.
import type {} from '@deepseek-ai/dsh-skill'
import { CREATE_WORKFLOW_DESCRIPTION, CREATE_WORKFLOW_SKILL } from './skill.ts'

export const name = 'command-workflows'
export const inject = ['commands', 'workflows', 'workflowSupervisor', 'skills']

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflowSupervisor: import('@deepseek-ai/dsh-workflow-supervisor').WorkflowSupervisor
    workflows: import('@deepseek-ai/dsh-workflow-registry').WorkflowRegistry
  }
}

/** Plugin config (all optional). */
export interface Config {
  /** Whether commands register (default true). */
  enabled?: boolean
}

export const Config: Schema<Config> = z.object({
  enabled: z.boolean().default(true),
})

/** One parsed `/workflow` line. */
type WorkflowCommand =
  | { readonly kind: 'empty' }
  | { readonly kind: 'launch'; readonly name: string; readonly args: Record<string, unknown> }
  | { readonly kind: 'control'; readonly action: 'pause' | 'resume' | 'stop' | 'save'; readonly displayName: string | undefined }
  | { readonly kind: 'malformed'; readonly reason: string }

const CONTROLS = new Set(['pause', 'resume', 'stop', 'save'])

/**
 * Parse the `/workflow` grammar: `<name> [json-args]` or `pause|resume|stop|save <display-name>`.
 * @param rawInput - the exact text following the command name (separator included).
 * @returns the parsed command variant, or `malformed`/`empty` rather than throwing.
 */
export function parseWorkflowCommand(rawInput: string): WorkflowCommand {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { kind: 'empty' }
  const parts = trimmed.split(/\s+/)
  if (parts[0] !== undefined && CONTROLS.has(parts[0])) {
    return { kind: 'control', action: parts[0] as 'pause' | 'resume' | 'stop' | 'save', displayName: parts[1] }
  }
  const name = parts[0] as string
  const rest = trimmed.slice(name.length).trim()
  if (rest === '') return { kind: 'launch', name, args: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(rest)
  } catch {
    return { kind: 'malformed', reason: `trailing args for "${name}" must be one JSON object — ${rest}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: `trailing args for "${name}" must be a JSON object (wrap arrays/scalars in a field)` }
  }
  return { kind: 'launch', name, args: parsed as Record<string, unknown> }
}

/** Render any thrown value without trusting coercion. */
function renderThrown(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const supervisor = ctx.workflowSupervisor

  // Bundled authoring skill: both the slash menu (user-invocable, description
  // names /create-workflow) and the model find it through ctx.skills.
  ctx.skills.register({
    name: 'create-workflow',
    description: CREATE_WORKFLOW_DESCRIPTION,
    content: CREATE_WORKFLOW_SKILL,
    source: 'runtime',
    invocation: { modelInvocable: true, userInvocable: true },
  })

  ctx.commands.register({
    name: 'workflows',
    description: 'Open the workflow run dashboard',
    handler: () => ({ kind: 'success' }),
  })

  ctx.commands.register({
    name: 'workflow',
    description: 'Launch a saved workflow or pause/resume/stop/save a run',
    input: { hint: '<name> [json-args] | pause|resume|stop|save <display-name>' },
    handler: async ({ agent, rawInput }) => {
      const command = parseWorkflowCommand(rawInput)
      switch (command.kind) {
        case 'empty':
          return { kind: 'success' }
        case 'malformed':
          return { kind: 'error', text: command.reason }
        case 'control': {
          if (command.displayName === undefined || command.displayName === '') {
            return { kind: 'error', text: `usage: /workflow ${command.action} <display-name>` }
          }
          try {
            switch (command.action) {
              case 'pause': {
                supervisor.pause(command.displayName, agent)
                return { kind: 'success', text: `Paused workflow "${command.displayName}". Open /workflows to resume or stop it.` }
              }
              case 'resume': {
                supervisor.resume(command.displayName, agent)
                return { kind: 'success', text: `Resumed workflow "${command.displayName}". Open /workflows to watch it.` }
              }
              case 'stop': {
                supervisor.stop(command.displayName, agent)
                return { kind: 'success', text: `Stopped workflow "${command.displayName}".` }
              }
              case 'save': {
                const path = await supervisor.save(command.displayName, agent)
                return { kind: 'success', text: `Saved workflow "${command.displayName}" to ${path}.` }
              }
            }
          } catch (error) {
            return { kind: 'error', text: renderThrown(error) }
          }
        }
        case 'launch': {
          const definition = await ctx.workflows.get(command.name, {
            ...undefinedCwd(agent.session.header.cwd),
          })
          if (definition === undefined) {
            return { kind: 'error', text: `no saved workflow named "${command.name}"` }
          }
          try {
            const launched = await supervisor.start({ definition, args: command.args, parent: agent })
            return { kind: 'success', text: `Started workflow "${launched.displayName}" in the background. Open /workflows to watch it.` }
          } catch (error) {
            return { kind: 'error', text: renderThrown(error) }
          }
        }
      }
    },
  })

  ctx.commands.register({
    name: 'create-workflow',
    description: 'Author, smoke-check, and save a new workflow (create-workflow skill)',
    input: { hint: '[what the workflow should do]' },
    handler: ({ agent, rawInput }) => {
      const detail = rawInput.trim()
      const message = detail === ''
        ? 'The user invoked /create-workflow. Load and follow the create-workflow skill to author a workflow.'
        : `The user invoked /create-workflow: ${detail}. Load and follow the create-workflow skill to author it.`
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user', source: 'create-workflow', summary: `Invoke /create-workflow${detail === '' ? '' : `: ${detail}`}` },
      }))
      return { kind: 'success', text: 'Opened the workflow authoring skill.' }
    },
  })

  // One launch command per saved definition name, refreshed on workflows/change.
  const disposers = new Map<string, () => void>()
  const refresh = (): void => {
    void ctx.workflows.list({
      ...undefinedCwd(process.cwd()),
    }).then((definitions) => {
      const names = new Set(definitions.map(definition => definition.name))
      for (const [registered, dispose] of [...disposers]) {
        if (!names.has(registered)) {
          dispose()
          disposers.delete(registered)
        }
      }
      for (const definition of definitions) {
        if (disposers.has(definition.name)) continue
        registerDefinition(ctx, definition, supervisor, disposers)
      }
    }).catch((error) => {
      ctx.logger.warn(`command-workflows: definition refresh failed: ${renderThrown(error)}`)
    })
  }
  ctx.on('workflows/change', refresh)
  refresh()
}

/** Register one `/<name>` launch command, silently losing to a built-in name collision. */
function registerDefinition(
  ctx: Context,
  definition: WorkflowDefinitionSummary,
  supervisor: Context['workflowSupervisor'],
  disposers: Map<string, () => void>,
): void {
  try {
    const disposer = ctx.commands.register({
      name: definition.name,
      description: definition.description,
      input: { hint: '[json-args]' },
      handler: async ({ agent, rawInput }) => {
        const trimmed = rawInput.trim()
        let args: Record<string, unknown> = {}
        if (trimmed !== '') {
          try {
            const parsed: unknown = JSON.parse(trimmed)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
            args = parsed as Record<string, unknown>
          } catch {
            return { kind: 'error', text: `/${definition.name} args must be one JSON object (wrap arrays/scalars in a field)` }
          }
        }
        const full = await ctx.workflows.get(definition.name, { ...undefinedCwd(agent.session.header.cwd) })
        if (full === undefined) return { kind: 'error', text: `no saved workflow named "${definition.name}"` }
        try {
          const launched = await supervisor.start({ definition: full, args, parent: agent })
          return { kind: 'success', text: `Started workflow "${launched.displayName}" in the background. Open /workflows to watch it.` }
        } catch (error) {
          return { kind: 'error', text: renderThrown(error) }
        }
      },
    })
    disposers.set(definition.name, disposer)
  } catch {
    // A built-in owns the bare name; the workflow remains reachable via
    // /workflow <name>. This is deliberate — do not silently steal /plan etc.
  }
}

/** The `cwd` lookup field, omitted when a session has no header cwd. */
function undefinedCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd }
}

/**
 * Workflow host commands: `/workflow` (launch/control grammar),
 * `/create-workflow` (authoring skill entry), and one launch command per saved
 * definition name. Definition changes refresh the aliases; command-registry
 * changes move collisions to or from a qualified name. Web owns the
 * dashboard's `/workflows` action so opening it creates no Host command
 * lifecycle record.
 *
 * Launches are background and return the display handle; the run itself is
 * owned by `ctx.workflowSupervisor`. No internal run id ever reaches command
 * text — users pass display names to pause/resume/stop/save.
 * @module @deepseek-ai/dsh-command-workflows
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { isWorkflowDisplayName, isWorkflowName } from '@deepseek-ai/dsh-workflow-registry'
import type { WorkflowDefinitionSummary } from '@deepseek-ai/dsh-workflow-registry'
// Type-only: resolves ctx.commands for the command registrations.
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.skills for the bundled authoring skill.
import type {} from '@deepseek-ai/dsh-skill'
// Type-only: resolves ctx.workflowRunRecorder for durable launch attribution.
import type {} from '@deepseek-ai/dsh-workflow-run-recorder'
import { CREATE_WORKFLOW_DESCRIPTION, CREATE_WORKFLOW_SKILL } from './skill.ts'

export const name = 'command-workflows'
export const inject = [
  'agents',
  'commands',
  'workflows',
  'workflowSupervisor',
  'workflowRunRecorder',
  'skills',
]

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
  | { readonly kind: 'control'; readonly action: 'pause' | 'resume' | 'stop' | 'save'; readonly displayName: string }
  | { readonly kind: 'malformed'; readonly reason: string }

const CONTROLS = new Set(['pause', 'resume', 'stop', 'save'])
const CREATE_WORKFLOW_PROVIDER = 'workflow-authoring'
const CREATE_WORKFLOW_RANK = 0

/** Complete terminal/headless help for a bare `/workflow` invocation. */
export const WORKFLOW_COMMAND_HELP = [
  'Launch or control a workflow.',
  '',
  'Usage:',
  '/workflow <name> [<json-args>]',
  '/workflow pause <display-name>',
  '/workflow resume <display-name>',
  '/workflow stop <display-name>',
  '/workflow save <display-name>',
  '',
  'Examples:',
  '/workflow review-changes {"target":"origin/main...HEAD"}',
  '/workflow pause review-changes',
  '/workflow resume review-changes',
  '/workflow stop review-changes-2',
  '/workflow save review-changes',
].join('\n')

/** Provider-owned locator for the single bundled workflow-authoring skill. */
const CREATE_WORKFLOW_LOCATOR = Object.freeze({ name: 'create-workflow' as const })

/**
 * Register the product-owned authoring skill above workspace/user providers.
 * `/create-workflow` must inject this exact body rather than letting an
 * untrusted same-name project skill replace the shipped authoring procedure.
 * @returns the provider contribution for the bundled authoring skill.
 */
function createWorkflowProvider(): SkillProvider {
  const definition: SkillDefinition = Object.freeze({
    name: 'create-workflow',
    description: CREATE_WORKFLOW_DESCRIPTION,
    content: CREATE_WORKFLOW_SKILL,
    source: 'bundled',
    provider: CREATE_WORKFLOW_PROVIDER,
    invocation: Object.freeze({ modelInvocable: true, userInvocable: true }),
  })
  const candidate: SkillCandidate = Object.freeze({
    name: definition.name,
    description: definition.description,
    source: definition.source,
    provider: definition.provider,
    invocation: definition.invocation,
    rank: CREATE_WORKFLOW_RANK,
    locator: CREATE_WORKFLOW_LOCATOR,
  })
  return Object.freeze({
    name: CREATE_WORKFLOW_PROVIDER,
    list() { return Promise.resolve([candidate]) },
    get(_selected: SkillCandidate) {
      return Promise.resolve(definition)
    },
  })
}

/**
 * Parse the `/workflow` grammar: `<name> [json-args]` or `pause|resume|stop|save <display-name>`.
 * @param rawInput - the exact text following the command name (separator included).
 * @returns the parsed command variant, or `malformed`/`empty` rather than throwing.
 */
export function parseWorkflowCommand(rawInput: string): WorkflowCommand {
  const trimmed = rawInput.trim()
  if (trimmed === '') return { kind: 'empty' }
  const parts = trimmed.split(/\s+/)
  const first = parts[0] as string
  if (CONTROLS.has(first)) {
    if (parts.length !== 2) {
      return { kind: 'malformed', reason: `usage: /workflow ${parts[0]} <display-name>` }
    }
    const displayName = parts[1] as string
    if (!isWorkflowDisplayName(displayName)) {
      return { kind: 'malformed', reason: `usage: /workflow ${first} <display-name>` }
    }
    return { kind: 'control', action: first as 'pause' | 'resume' | 'stop' | 'save', displayName }
  }
  const name = first
  if (!isWorkflowName(name)) return { kind: 'malformed', reason: `"${name}" is not a valid workflow name` }
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

  // Product-owned provider precedence keeps `/create-workflow` deterministic:
  // a workspace may define a colliding skill, but it cannot replace the
  // bundled authoring procedure selected by this command.
  ctx.skills.registerProvider(() => createWorkflowProvider())

  ctx.commands.register({
    name: 'workflow',
    description: 'Launch a saved workflow or pause/resume/stop/save a run',
    input: { hint: '<name> [json-args] | pause|resume|stop|save <display-name>' },
    handler: async ({ agent, rawInput, signal }) => {
      const command = parseWorkflowCommand(rawInput)
      switch (command.kind) {
        case 'empty':
          return { kind: 'success', text: WORKFLOW_COMMAND_HELP }
        case 'malformed':
          return { kind: 'error', text: command.reason }
        case 'control': {
          try {
            signal.throwIfAborted()
            switch (command.action) {
              case 'pause': {
                await supervisor.pause(command.displayName, agent, signal)
                return { kind: 'success', text: `Paused workflow "${command.displayName}". Open /workflows to resume or stop it.` }
              }
              case 'resume': {
                supervisor.resume(command.displayName, agent)
                return { kind: 'success', text: `Resumed workflow "${command.displayName}". Open /workflows to watch it.` }
              }
              case 'stop': {
                await supervisor.stop(command.displayName, agent, signal)
                return { kind: 'success', text: `Stopped workflow "${command.displayName}".` }
              }
              case 'save': {
                const path = await supervisor.save(command.displayName, agent, undefined, signal)
                return { kind: 'success', text: `Saved workflow "${command.displayName}" to ${path}.` }
              }
            }
          } catch (error) {
            return { kind: 'error', text: renderThrown(error) }
          }
        }
        case 'launch': {
          try {
            const definition = await ctx.workflows.get(command.name, {
              ...undefinedCwd(agent.session.header.cwd),
              signal,
            })
            if (definition === undefined) {
              return { kind: 'error', text: `no saved workflow named "${command.name}"` }
            }
            const launched = await ctx.workflowRunRecorder.launch(agent.session, () =>
              supervisor.start({ definition, args: command.args, signal, parent: agent }))
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
    handler: ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      const detail = rawInput.trim()
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: `/create-workflow${detail === '' ? '' : ` ${detail}`}` }],
        source: { kind: 'user' },
      }))
      return { kind: 'success', text: 'Opened the workflow authoring skill.' }
    },
  })

  // Definition aliases belong to each receiving agent's scoped command layer:
  // project discovery follows that session's cwd and the scope tears down with
  // the agent. Each refresh aborts/fences its predecessor so stale I/O cannot
  // replace a newer catalog.
  const aliases = new Map<Agent, AgentAliases>()
  const installAgent = (agent: Agent): void => {
    if (aliases.has(agent)) return
    const state: AgentAliases = {
      agent,
      abort: undefined,
      definitions: new Map(),
      registrations: new Map(),
      reconcileQueued: false,
    }
    aliases.set(agent, state)
    refreshAliases(ctx, state, supervisor)
  }
  const removeAgent = (agent: Agent): void => {
    const state = aliases.get(agent)
    if (state === undefined) return
    aliases.delete(agent)
    state.abort?.abort(new Error('workflow alias owner disposed'))
    for (const registration of state.registrations.values()) registration.dispose()
    state.registrations.clear()
  }
  for (const agent of ctx.agents.list()) installAgent(agent)
  ctx.on('agent/created', ({ agent }) => { installAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { removeAgent(agent) })
  ctx.on('workflows/change', () => {
    for (const state of aliases.values()) refreshAliases(ctx, state, supervisor)
  })
  ctx.on('commands/change', () => {
    for (const state of aliases.values()) {
      scheduleAliasReconciliation(ctx, aliases, state, supervisor)
    }
  })
  ctx.effect(() => () => {
    for (const agent of [...aliases.keys()]) removeAgent(agent)
  }, 'command-workflows: dynamic aliases')
}

interface AliasRegistration {
  readonly commandName: string
  readonly description: string
  readonly handler: CommandDefinition['handler']
  readonly dispose: () => void
}

interface AgentAliases {
  readonly agent: Agent
  abort: AbortController | undefined
  definitions: Map<string, WorkflowDefinitionSummary>
  readonly registrations: Map<string, AliasRegistration>
  reconcileQueued: boolean
}

/** Coalesce registry notifications caused by alias registration itself. */
function scheduleAliasReconciliation(
  ctx: Context,
  aliases: ReadonlyMap<Agent, AgentAliases>,
  state: AgentAliases,
  supervisor: Context['workflowSupervisor'],
): void {
  if (state.reconcileQueued) return
  state.reconcileQueued = true
  queueMicrotask(() => {
    state.reconcileQueued = false
    if (aliases.get(state.agent) !== state) return
    reconcileAliases(ctx, state, supervisor)
  })
}

/** Abort/fence one agent catalog refresh and apply only its latest result. */
function refreshAliases(
  ctx: Context,
  state: AgentAliases,
  supervisor: Context['workflowSupervisor'],
): void {
  state.abort?.abort(new Error('workflow alias catalog superseded'))
  const abort = new AbortController()
  state.abort = abort
  void ctx.workflows.list({
    ...undefinedCwd(state.agent.session.header.cwd),
    signal: abort.signal,
  }).then((definitions) => {
    if (abort.signal.aborted) return
    state.definitions = new Map(definitions.map(definition => [definition.name, definition]))
    reconcileAliases(ctx, state, supervisor)
  }).catch((error: unknown) => {
    if (abort.signal.aborted) return
    ctx.logger.warn(`command-workflows: definition refresh failed: ${renderThrown(error)}`)
  })
}

/** Make one scoped fallback-alias set match the latest definition catalog. */
function reconcileAliases(
  ctx: Context,
  state: AgentAliases,
  supervisor: Context['workflowSupervisor'],
): void {
  const wanted = state.definitions
  const commandNames = allocateWorkflowCommandNames(ctx, state)
  for (const [name, registration] of [...state.registrations]) {
    const definition = wanted.get(name)
    if (definition !== undefined
      && registration.description === definition.description
      && registration.commandName === commandNames.get(name)) continue
    registration.dispose()
    state.registrations.delete(name)
  }
  for (const definition of wanted.values()) {
    if (state.registrations.has(definition.name)) continue
    const commandName = commandNames.get(definition.name)
    /* v8 ignore next -- the allocator returns one command name for every definition key */
    if (commandName === undefined) throw new Error(`missing command alias allocation for "${definition.name}"`)
    state.registrations.set(
      definition.name,
      registerDefinition(state.agent.ctx, ctx, commandName, definition, supervisor),
    )
  }
}

/** Allocate stable aliases without taking another saved definition's bare name. */
function allocateWorkflowCommandNames(ctx: Context, state: AgentAliases): ReadonlyMap<string, string> {
  const allocated = new Map<string, string>()
  const reservedBareNames = new Set(state.definitions.keys())
  const ownHandlers = new Set([...state.registrations.values()].map(registration => registration.handler))
  const externallyOccupied = (name: string): boolean => {
    const effective = ctx.commands.find(state.agent, name)
    return effective !== undefined && !ownHandlers.has(effective.handler)
  }
  const sortedNames = [...reservedBareNames].sort()

  // Give every definition whose exact name is available its canonical alias
  // before allocating qualified aliases for definitions that collide.
  const used = new Set<string>()
  for (const definitionName of sortedNames) {
    if (externallyOccupied(definitionName)) continue
    allocated.set(definitionName, definitionName)
    used.add(definitionName)
  }
  for (const definitionName of sortedNames) {
    if (allocated.has(definitionName)) continue
    let commandName = `workflow-${definitionName}`
    while (reservedBareNames.has(commandName) || used.has(commandName) || externallyOccupied(commandName)) {
      commandName = `workflow-${commandName}`
    }
    allocated.set(definitionName, commandName)
    used.add(commandName)
  }
  return allocated
}

/** Register one cwd-sensitive saved-workflow launch command in its owning agent scope. */
function registerDefinition(
  ownerCtx: Context,
  workflowCtx: Context,
  commandName: string,
  definition: WorkflowDefinitionSummary,
  supervisor: Context['workflowSupervisor'],
): AliasRegistration {
  const handler: CommandDefinition['handler'] = async ({ agent, rawInput, signal }) => {
    const trimmed = rawInput.trim()
    let args: Record<string, unknown> = {}
    if (trimmed !== '') {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
        args = parsed as Record<string, unknown>
      } catch {
        return { kind: 'error', text: `/${commandName} args must be one JSON object (wrap arrays/scalars in a field)` }
      }
    }
    try {
      const full = await workflowCtx.workflows.get(definition.name, {
        ...undefinedCwd(agent.session.header.cwd),
        signal,
      })
      if (full === undefined) return { kind: 'error', text: `no saved workflow named "${definition.name}"` }
      const launched = await workflowCtx.workflowRunRecorder.launch(agent.session, () =>
        supervisor.start({ definition: full, args, signal, parent: agent }))
      return { kind: 'success', text: `Started workflow "${launched.displayName}" in the background. Open /workflows to watch it.` }
    } catch (error) {
      return { kind: 'error', text: renderThrown(error) }
    }
  }
  const fiber = ownerCtx.inject(['commands'], (registrationCtx) => {
    registrationCtx.commands.registerFallback({
      name: commandName,
      description: commandName === definition.name
        ? definition.description
        : `Saved workflow "${definition.name}": ${definition.description}`,
      input: { hint: '[json-args]' },
      handler,
    })
  })
  return {
    commandName,
    description: definition.description,
    handler,
    dispose: () => { void fiber.dispose() },
  }
}

/** The `cwd` lookup field, omitted when a session has no header cwd. */
function undefinedCwd(cwd: string | undefined): { cwd?: string } {
  return cwd === undefined ? {} : { cwd }
}

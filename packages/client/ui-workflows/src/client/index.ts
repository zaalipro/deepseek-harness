/**
 * Workflow dashboard browser plugin: a client-owned `/workflows` action opens
 * a bounded, on-demand control-room overlay without writing command rows.
 */

import type { WorkflowDefinitionSummaryView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CommandDecoration, CommandUiContract,
} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { DashboardWorkflowRunsAdapter } from './adapter.ts'
import { en, NS, zh, type WorkflowsKey } from './locales.ts'
import { createWorkflowsStore } from './store.ts'
import { WorkflowsDashboard, type WorkflowsDashboardInjected } from './WorkflowsDashboard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workflow dashboard copy. */
    workflows: WorkflowsKey
  }
}

export type {
  WorkflowRunsOperations, WorkflowRunsSourceSnapshot,
} from './contract.ts'
export type { WorkflowsDashboardInjected, WorkflowsDashboardProps } from './WorkflowsDashboard.tsx'
export type {
  WorkflowsActions, WorkflowsState, WorkflowInspectorTab, WorkflowMobileView,
} from './store.ts'

/** Required services: overlay, client commands, workflow controller, sessions, and locale. */
export const inject = ['slots', 'sessions', 'workflowRuns', 'commandUi', 'locale', 'remote']

/** Compact definition metadata for one row in the bare `/workflow` picker. */
function definitionDetail(definition: WorkflowDefinitionSummaryView): string {
  const purpose = definition.whenToUse === undefined
    ? definition.description
    : `${definition.description} — ${definition.whenToUse}`
  return `${purpose} · ${definition.scope}`
}

/**
 * Register the overlay and the browser-owned `/workflows` action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflows: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = ctx.get('workflowRuns')
  if (controller === undefined) throw new Error('workflow-runs controller is unavailable')
  const adapter = new DashboardWorkflowRunsAdapter(controller)
  let dashboardActions: BoundActions<ReturnType<typeof createWorkflowsStore>> | undefined

  ctx.effect(() => () => {
    dashboardActions = undefined
    adapter.dispose()
  }, 'ui-workflows: dashboard adapter')

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workflows-dashboard',
    order: 100,
    locale: NS,
    store: createWorkflowsStore,
    inject: (actions: BoundActions<ReturnType<typeof createWorkflowsStore>>): WorkflowsDashboardInjected => {
      dashboardActions = actions
      return {
        hooks: { workflowRuns: adapter.source },
        operations: adapter,
      }
    },
  }, WorkflowsDashboard))

  const commands = ctx.get('commandUi') as CommandUiContract
  ctx.effect(() => commands.register({
    name: 'workflows',
    description: t('command.description'),
    available: () => true,
    ui: {
      kind: 'action',
      run: () => {
        if (dashboardActions === undefined) {
          throw new Error('workflow dashboard overlay is not mounted')
        }
        dashboardActions.open()
      },
    },
  }), 'ui-workflows: /workflows action')

  ctx.effect(() => commands.decorate({
    name: 'workflow',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: async (session, signal) => {
        const result = await ctx.remote.workflowDefinitions.list(session.sessionId, signal)
        if (!result.ok) {
          throw new Error(`workflow definitions failed: ${result.error.code}: ${result.error.message}`)
        }
        return result.value.map(definition => ({
          id: definition.name,
          label: definition.name,
          detail: definitionDetail(definition),
        }))
      },
      onSelect: async (option, session) => {
        const live = ctx.sessions.binding(session.sessionId)?.session
        if (live === undefined) throw new Error('this session is not available')
        const result = await live.command(`/workflow ${option.id}`)
        if (!result.ok) {
          throw new Error(`workflow launch failed: ${result.error.code}: ${result.error.message}`)
        }
        if (!result.value.matched) throw new Error('the host offers no /workflow command')
      },
    },
  } satisfies CommandDecoration), 'ui-workflows: /workflow definition picker')
}

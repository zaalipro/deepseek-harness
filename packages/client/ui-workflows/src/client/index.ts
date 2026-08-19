/**
 * Workflow run dashboard plugin, browser half: a fullscreen overlay registered
 * into the frame's `shell.overlay` slot. Run data arrives entirely through the
 * `workflowRunsBySession` mirror (session/workflow-runs frames), so the plugin
 * issues no read RPC. Controls are host commands executed through the commands
 * Remote; the `/workflows` command opens the overlay via `command/executed`.
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the generated commands Remote (ctx.remote.commands).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the `command/executed` event declaration (ui-commands service).
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import { en, NS, zh, type WorkflowsKey } from './locales.ts'
import { createWorkflowsStore } from './store.ts'
import { WorkflowsDashboard, type WorkflowsDashboardInjected } from './WorkflowsDashboard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workflow dashboard copy. */
    workflows: WorkflowsKey
  }
}

export type { WorkflowsDashboardInjected, WorkflowsDashboardProps } from './WorkflowsDashboard.tsx'
export type { WorkflowsActions, WorkflowsState } from './store.ts'

/** Required services: overlay slot, sessions mirror, commands Remote, and locale. */
export const inject = ['slots', 'sessions', 'remote', 'remote.commands', 'locale']

/**
 * Client plugin body: register dictionaries and the dashboard overlay, then
 * open it when the `/workflows` command executes locally.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflows: dictionaries')

  // The bound actions land here through the register's store-inject hook (the
  // framework creates the one root-scope instance); the command listener below
  // calls them to open the overlay without reaching into the component.
  let dashboardActions: BoundActions<ReturnType<typeof createWorkflowsStore>> | undefined

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'workflows-dashboard',
    order: 100,
    locale: NS,
    store: createWorkflowsStore,
    inject: (actions: BoundActions<ReturnType<typeof createWorkflowsStore>>): WorkflowsDashboardInjected => {
      dashboardActions = actions
      return {
        runControl: (sessionId: SessionId, displayName: string, action: string): void => {
          void ctx.remote.commands.execute(sessionId, `/workflow ${action} ${displayName}`)
        },
      }
    },
  }, WorkflowsDashboard))

  // The `/workflows` host command returns a bare success; this listener turns
  // its local completion into the overlay. Every other client receives the
  // durable command nodes but never this local acknowledgment, so the overlay
  // opens only in the tab the user typed in.
  ctx.on('command/executed', (_sessionId, command, result) => {
    if (result.kind !== 'success' || command !== 'workflows') return
    dashboardActions?.open()
  })
}

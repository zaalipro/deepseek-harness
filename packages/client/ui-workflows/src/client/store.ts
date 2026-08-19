/**
 * Dashboard-only viewing state: whether the overlay is open and which run is
 * selected. Run data itself lives in the runtime sessions mirror
 * (`workflowRunsBySession`), never here — a declared store carries only
 * interaction state that survives remounts.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** The state one workflows store instance exposes. */
export interface WorkflowsState {
  open: boolean
  selected: string | undefined
}

/** Annotation twin of the actions literal (the export needs a declared return type). */
export type WorkflowsActions = {
  /** Open the overlay, optionally restoring a selected display name. */
  open: (draft: WorkflowsState, selected?: string) => void
  /** Close the overlay (selection survives for the next open). */
  close: (draft: WorkflowsState) => void
  /** Select one run's detail view by display name. */
  select: (draft: WorkflowsState, selected: string) => void
}

/**
 * Create one workflows store (the framework instantiates it per entry).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkflowsStore(): EngineStoreHandle<WorkflowsState, WorkflowsActions> {
  return defineStore({
    init: (): WorkflowsState => ({ open: false, selected: undefined }),
    actions: {
      open: (draft, selected) => {
        draft.open = true
        if (selected !== undefined) draft.selected = selected
      },
      close: (draft) => { draft.open = false },
      select: (draft, selected) => { draft.selected = selected },
    },
  })
}

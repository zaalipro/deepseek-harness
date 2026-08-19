/** Dashboard interaction state; workflow business data stays in its controller. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** The state one workflows store instance exposes. */
export type WorkflowInspectorTab = 'outcome' | 'logs' | 'result' | 'artifacts'

/** Narrow-screen drilldown location. */
export type WorkflowMobileView = 'runs' | 'run' | 'inspector'

/** The state one workflows dashboard store exposes. */
export interface WorkflowsState {
  open: boolean
  selectedRunId: string | undefined
  selectedMemberId: string | undefined
  inspectorTab: WorkflowInspectorTab
  mobileView: WorkflowMobileView
}

/** Annotation twin of the actions literal (the export needs a declared return type). */
export type WorkflowsActions = {
  /** Open the overlay at the retained selection. */
  open: (draft: WorkflowsState) => void
  /** Close the overlay without discarding selection. */
  close: (draft: WorkflowsState) => void
  /** Select a run and reveal its execution view on narrow screens. */
  selectRun: (draft: WorkflowsState, runId: string) => void
  /** Reconcile a removed or initial run without changing narrow navigation. */
  reconcileRun: (draft: WorkflowsState, runId: string) => void
  /** Select a member and reveal its outcome inspector. */
  selectMember: (draft: WorkflowsState, memberId: string) => void
  /** Select one inspector section. */
  selectTab: (draft: WorkflowsState, tab: WorkflowInspectorTab) => void
  /** Return to the run navigator on narrow screens. */
  showRuns: (draft: WorkflowsState) => void
  /** Return to the execution view on narrow screens. */
  showRun: (draft: WorkflowsState) => void
}

/**
 * Create one workflows store (the framework instantiates it per entry).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkflowsStore(): EngineStoreHandle<WorkflowsState, WorkflowsActions> {
  return defineStore({
    init: (): WorkflowsState => ({
      open: false,
      selectedRunId: undefined,
      selectedMemberId: undefined,
      inspectorTab: 'outcome',
      mobileView: 'runs',
    }),
    actions: {
      open: (draft) => { draft.open = true },
      close: (draft) => { draft.open = false },
      selectRun: (draft, runId) => {
        if (draft.selectedRunId !== runId) draft.selectedMemberId = undefined
        draft.selectedRunId = runId
        draft.mobileView = 'run'
      },
      reconcileRun: (draft, runId) => {
        if (draft.selectedRunId !== runId) draft.selectedMemberId = undefined
        draft.selectedRunId = runId
      },
      selectMember: (draft, memberId) => {
        draft.selectedMemberId = memberId
        draft.inspectorTab = 'outcome'
        draft.mobileView = 'inspector'
      },
      selectTab: (draft, tab) => {
        draft.inspectorTab = tab
        draft.mobileView = 'inspector'
      },
      showRuns: (draft) => { draft.mobileView = 'runs' },
      showRun: (draft) => { draft.mobileView = 'run' },
    },
  })
}

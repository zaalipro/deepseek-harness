import type {
  ChatConversationViewNode, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkflowRunRecordAgentEndData,
  WorkflowRunRecordAgentStartData,
  WorkflowRunRecordEndData,
} from '@deepseek-ai/dsh-workflow-run-recorder/types'

/** Status shown for a workflow, phase, or member. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** Final renderer data for one member. */
export interface WorkflowRunMemberData {
  readonly seq: number
  readonly label: string
  readonly childId: SessionId
  readonly status: WorkflowRunStatus
}

/** Final renderer data for one exact phase identity. */
export interface WorkflowRunPhaseData {
  readonly key: string
  /** `null` is the absent field; the empty string remains a distinct identity. */
  readonly phase: string | null
  readonly members: readonly WorkflowRunMemberData[]
}

/** Final keyed Chat payload for one workflow run. */
export interface WorkflowRunChatData {
  readonly name: string
  readonly status: WorkflowRunStatus
  readonly phases: readonly WorkflowRunPhaseData[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Durable top-level workflow run and all members that actually started. */
    'workflow-run': WorkflowRunChatData
  }
}

interface WorkflowMemberState extends Omit<WorkflowRunRecordAgentStartData, 'runId'> {
  readonly outcome?: WorkflowRunRecordAgentEndData['outcome']
}

interface WorkflowState {
  readonly name: string
  readonly stopReason?: WorkflowRunRecordEndData['stopReason']
  readonly members: readonly WorkflowMemberState[]
}

/**
 * Build a collision-free phase key preserving absent versus empty identity.
 * @param phase - exact phase string, or null for an omitted field.
 * @returns the stable renderer key for that phase identity.
 */
export function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

function statusFromStopReason(stopReason: WorkflowRunRecordEndData['stopReason']): WorkflowRunStatus {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'error': return 'failed'
    case 'interrupted': return 'interrupted'
    /* v8 ignore next -- the logical stop-reason union is closed and every variant is handled above. */
    default: return stopReason satisfies never
  }
}

function statusFromOutcome(outcome: WorkflowRunRecordAgentEndData['outcome']): WorkflowRunStatus {
  switch (outcome) {
    case 'completed': return 'completed'
    case 'cancelled': return 'cancelled'
    case 'failed': return 'failed'
    /* v8 ignore next -- the logical member outcome union is closed and every variant is handled above. */
    default: return outcome satisfies never
  }
}

function projectWorkflow(
  context: ConversationNodeContext<WorkflowState>,
): WorkflowRunChatData {
  const state = context.state as WorkflowState
  const phases = new Map<string, { phase: string | null; members: WorkflowRunMemberData[] }>()
  for (const member of state.members) {
    const phase = member.phase === undefined ? null : member.phase
    const key = workflowPhaseKey(phase)
    let group = phases.get(key)
    if (group === undefined) {
      group = { phase, members: [] }
      phases.set(key, group)
    }
    group.members.push({
      seq: member.seq,
      label: member.label,
      childId: member.childId,
      status: member.outcome === undefined
        ? 'running'
        : statusFromOutcome(member.outcome),
    })
  }
  const projectedPhases = [...phases].map(([key, phase]) => ({
    key,
    phase: phase.phase,
    members: phase.members,
  }))
  return {
    name: state.name,
    status: state.stopReason === undefined
      ? 'running'
      : statusFromStopReason(state.stopReason),
    phases: projectedPhases,
  }
}

function updateAgentStart(state: WorkflowState, data: WorkflowRunRecordAgentStartData): WorkflowState {
  const member: WorkflowMemberState = {
    seq: data.seq,
    label: data.label,
    ...data.phase === undefined ? {} : { phase: data.phase },
    childId: data.childId,
  }
  return { ...state, members: [...state.members, member] }
}

function updateAgentEnd(state: WorkflowState, data: WorkflowRunRecordAgentEndData): WorkflowState {
  return {
    ...state,
    members: state.members.map(member => member.seq === data.seq
      ? { ...member, outcome: data.outcome }
      : member),
  }
}

/** Durable workflow event family folded into one keyed Chat node. */
export const workflowRunDefinition: ConversationNodeDefinition<WorkflowState> = {
  kind: 'workflow-run',
  target: 'chat',
  match: (event) => {
    if (event.type === 'tool-workflow/run-start') return { id: String(event.data.runId), role: 'start' }
    if (event.type === 'tool-workflow/agent-start'
      || event.type === 'tool-workflow/agent-end'
      || event.type === 'tool-workflow/run-end') {
      return { id: String(event.data.runId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'tool-workflow/run-start') {
      throw new Error('workflow-run start requires tool-workflow/run-start')
    }
    return { name: match.event.data.name, members: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool-workflow/agent-start') {
      return updateAgentStart(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/agent-end') {
      return updateAgentEnd(context.state, match.event.data)
    }
    if (match.event.type === 'tool-workflow/run-end') {
      return { ...context.state, stopReason: match.event.data.stopReason }
    }
    return context.state
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    const data = projectWorkflow(context)
    return {
      key: context.key,
      kind: 'workflow-run',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data,
    }
  },
}

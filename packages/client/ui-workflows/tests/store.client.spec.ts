import { describe, expect, it } from 'vitest'
import { createWorkflowsStore } from '../src/client/store.ts'

describe('workflows interaction store', () => {
  it('retains the selected run while opening and closing the overlay', () => {
    const source = createWorkflowsStore().create()
    source.actions.selectRun('run-a')
    source.actions.close()
    expect(source.getSnapshot()).toMatchObject({
      open: false,
      selectedRunId: 'run-a',
      mobileView: 'run',
    })
    source.actions.open()
    expect(source.getSnapshot()).toMatchObject({ open: true, selectedRunId: 'run-a' })
  })

  it('clears a stale member when the selected run changes', () => {
    const source = createWorkflowsStore().create()
    source.actions.selectRun('run-a')
    source.actions.selectMember('member-a')
    expect(source.getSnapshot()).toMatchObject({
      selectedMemberId: 'member-a',
      inspectorTab: 'outcome',
      mobileView: 'inspector',
    })
    source.actions.selectRun('run-b')
    expect(source.getSnapshot()).toMatchObject({
      selectedRunId: 'run-b',
      selectedMemberId: undefined,
      mobileView: 'run',
    })
    source.actions.selectMember('member-b')
    source.actions.selectRun('run-b')
    expect(source.getSnapshot().selectedMemberId).toBe('member-b')
  })

  it('reconciles removed runs without forcing narrow navigation', () => {
    const source = createWorkflowsStore().create()
    source.actions.selectRun('run-a')
    source.actions.selectMember('member-a')
    source.actions.reconcileRun('run-b')
    expect(source.getSnapshot()).toMatchObject({
      selectedRunId: 'run-b',
      selectedMemberId: undefined,
      mobileView: 'inspector',
    })
    source.actions.selectMember('member-b')
    source.actions.reconcileRun('run-b')
    expect(source.getSnapshot().selectedMemberId).toBe('member-b')
  })

  it('moves between inspector sections and narrow-screen routes', () => {
    const source = createWorkflowsStore().create()
    source.actions.selectTab('logs')
    expect(source.getSnapshot()).toMatchObject({ inspectorTab: 'logs', mobileView: 'inspector' })
    source.actions.showRun()
    expect(source.getSnapshot().mobileView).toBe('run')
    source.actions.showRuns()
    expect(source.getSnapshot().mobileView).toBe('runs')
  })
})

import { describe, expect, it } from 'vitest'
import {
  decodeWorkerToHostMessage,
  WorkerToHostType,
  WorkflowProtocolError,
} from '../src/protocol.ts'

describe('worker protocol journal edges', () => {
  it('rejects an unknown journal entry kind after validating its common fields', () => {
    expect(() => decodeWorkerToHostMessage({
      type: WorkerToHostType.JournalCommit,
      entry: {
        kind: 'forged',
        ordinal: 1,
        callId: 'root/forged:1',
        fingerprint: '0'.repeat(64),
      },
    })).toThrow(new WorkflowProtocolError('message.entry.kind is not recognized'))
  })
})

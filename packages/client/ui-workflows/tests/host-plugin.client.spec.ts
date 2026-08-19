import { describe, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('ui-workflows host plugin', () => {
  it('has no host-side behavior', () => {
    apply()
  })
})

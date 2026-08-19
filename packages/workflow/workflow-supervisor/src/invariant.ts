/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workflow-supervisor`.
 * @module @deepseek-ai/dsh-workflow-supervisor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workflow-supervisor'

/** Cordis companion plugin name. */
export const name = 'workflow-supervisor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: display-name uniqueness and journal pairing are
 * enforced by the supervisor's own unit tests (the seam's `workflow/invariant`
 * already validates the lifecycle event pairing the supervisor consumes); no
 * independent duplicate event relation exists to fold.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

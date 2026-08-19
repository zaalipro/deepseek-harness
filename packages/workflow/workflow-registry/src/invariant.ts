/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workflow-registry`.
 * @module @deepseek-ai/dsh-workflow-registry/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workflow-registry'

/** Cordis companion plugin name. */
export const name = 'workflow-registry-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: definition envelopes are validated as data at parse
 * time (`parseDefinitionFile`), and discovery never writes a session event or
 * mutable relation another observer folds; violations fail loud at read.
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

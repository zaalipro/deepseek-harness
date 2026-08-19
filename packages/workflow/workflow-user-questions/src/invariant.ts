/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workflow-user-questions`.
 * @module @deepseek-ai/dsh-workflow-user-questions/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workflow-user-questions'

/** Cordis companion plugin name. */
export const name = 'workflow-user-questions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the supervisor owns the generation-fenced relation
 * between a gate request and its exact resume operation; this Consumer neither
 * persists nor independently projects that relation.
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

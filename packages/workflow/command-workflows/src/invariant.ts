/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-workflows`.
 * @module @deepseek-ai/dsh-command-workflows/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-workflows'

/** Cordis companion plugin name. */
export const name = 'command-workflows-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the `/workflow` grammar is pure (exported
 * `parseWorkflowCommand`, unit tested), and the command lifecycle is validated
 * by the commands registry's own invariant; no independent duplicate event
 * relation exists to fold.
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

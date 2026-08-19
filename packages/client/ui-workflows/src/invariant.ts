/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workflows`.
 * @module @deepseek-ai/dsh-client-ui-workflows/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workflows'

/** Cordis companion plugin name. */
export const name = 'ui-workflows-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this browser presentation plugin exposes no host-side
 * event sequence or mutable data relation; its roster reads the runtime
 * sessions mirror, whose frame contract is validated by the apiproxy schema.
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

# @deepseek-ai/dsh-client-ui-commands

English | [中文](README.zh.md)

Client command API (`ctx.commandUi`): the session-keyed command-directory cache, the `/` command source with `matchSpace`/`matchEnter` decision hooks, four-kind dispatch (`action` / `execute` / `popupSelect` / `leadingInput`), and client contribution or Host-decoration registration for business packages. The [Web command Agent Note](../../../.agents/notes/implemented/architecture/2026-07-25-web-command-surfaces-and-assembly.md) records the decision.

`src/client/contract.ts` is the fixed business API: `CommandUiContract.register(contribution)` and `decorate(decoration)` are everything a business package consumes. A contribution is a client-owned command whose `CommandUiSpec` is either `action` or `popupSelect`; a Host-name collision fails loud. An action runs its client callback without `command.execute` or Session events, single-flights by session and command name, then consumes the exact menu span or bare token only after success. Failure leaves the token and reports a composer error. Settlement is fenced to the exact session scope that admitted it. A popup keeps its option data self-contained, and this package owns its shell. A decoration adds only a bare-invocation popup to an existing Host command: the Host retains its catalog row, argument claim, execution, and lifecycle logging, while a decorated name absent from the session directory never fires. Host descriptors with `input` are `leadingInput`; remaining Host rows are `execute`.

`CommandDirectory` (`src/client/directory.ts`) is the one wire-derived cache, keyed by session. Ordinary sessions fetch through `command.list({sessionId})`, and the source's scope-birth `warm` hook prewarms the session's entry. Catalog-addressed continuable children resolve an empty command directory locally: `command.list` is Agent-bound, so prewarming it would activate a child merely to view persisted history. Entries are soft-invalidated by the forwarded `commands/change` owner event (old snapshots serve while the repull flies) and by forwarded `agent-preset/selected` for that one session (recomposing an agent registers nothing, so the registry-wide signal never fires for it), hard-invalidated by `connection/reset`, and epoch-guarded so a superseded pull can never overwrite a newer one. `matchSpace` answers synchronously from this cache only; `matchEnter` strong-waits it on the SubmitAttempt signal and rejects on warmup failure — a `/` line is never silently downgraded to a plain prompt.

After the directory resolves, every non-empty `/` line remains in the command plane. Unknown names and arguments supplied to bare-only commands keep the draft, show a composer error, and never reach the model input sink; known `leadingInput` commands still submit the complete line to the Host so their own parser owns malformed arguments.

After a matched Host `command.execute` settles, this browser emits local `command/executed(sessionId, name, result)` for browser side effects such as Session-log export. Other clients receive the durable command nodes but not this acknowledgment. Listener failures are contained and cannot change command admission. Client actions never emit it.

Menu queries fuzzy-match ordered, case-insensitive subsequences of command names. Prefixes rank first; separator boundaries, adjacent characters, and shorter gaps rank the remaining matches, with directory and contribution order breaking ties. This affects discovery only: space and Enter still require an exact command name. Rationale: [Web slash-command fuzzy discovery](../../../.agents/notes/implemented/feature/2026-08-04-web-slash-command-fuzzy-discovery.md).

`PopupSelectController` (`src/client/popup.ts`) is the headless shell state: `PopupSelectView` self-registers into `conversation.input.overlay` (the SlotMap key is ui-conversation's; this package pulls the declaration in with a type-only import — no runtime edge). The shell is a transient layer holding focus while open; token-segment consumption after onSelect runs both branches through `consumeTokenSegment` (menu-path span CAS, enter-path bare-token equality) against the draft face the wiring layer binds via `bindDraft`.

The `/client` entrypoint exports the plugin body (`apply`/`inject`), `CommandUiRuntime`, the directory and popup classes with their state types, and the fixed contract types; the shell component itself is internal to the overlay registration.

## Model Experience

Indirectly, through Host `execute` and `leadingInput` handlers that may change state another package projects into the next model request; client `action`, popup rendering, and notices add no model input by themselves.

#### KV Cache effect

None directly; this package neither assembles nor sends a provider request. Host command handlers or business callbacks may change what their owning packages contribute to the next request, and those packages own that token and cache behavior.

## Known Limitations and Deferred Work

- Client action and detached-admission failures notify only the originating session's composer; a failure settling after that session scope is disposed has no remaining in-product notice.

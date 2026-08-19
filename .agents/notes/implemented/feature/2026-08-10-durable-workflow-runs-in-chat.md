# Agent Note: Durable workflow runs in Chat

Status: implemented

English | [中文](2026-08-10-durable-workflow-runs-in-chat.zh.md)

## Problem

The ordinary workflow tool row owns the model call and final tool result, but those two records do not explain which members actually started, how they were grouped, whether each member completed, failed, or was cancelled, or what remained unfinished when a process stopped. Live `workflow/*` events expose those facts only inside the current process, so a refresh or later Session open loses the run history.

The Web Client already assembles business-owned Conversation Nodes from durable Session events. Workflow history therefore needs a producer that can correlate one accepted run with its calling Session, a minimal durable protocol that remains meaningful as a prefix, and an independent renderer that does not take ownership away from the existing tool card.

## Decision

`dsh-workflow-run-recorder` projects an explicitly attributed top-level logical run into the calling Agent's Session. Human workflow commands and root workflow tool calls each wrap exactly one supervisor launch; nested, internal, and unattributed launches remain dashboard-only. `tool-workflow/run-start` records the stable supervised `runId` and display name; matching logical member events from every engine attempt record the cumulative member sequence, exact label, optional exact phase, child Session id, and outcome. Pause, needs-input, and budget-limited settlements leave the record open; `tool-workflow/run-end` records the logical stop reason exactly once after the terminal attempt has disposed. Closing the Turn or Step that launched background work does not interrupt it.

Recording is observational. The first failed Session append disables all later writes for that run, logs one warning, and never changes cancellation, result mapping, or disposal. Each possible failure leaves either no record or a legal continuous prefix: a started run may lack later members or its ending, and a started member may lack its ending. The package invariant rejects duplicate run starts, invalid or reused positive member sequences, unpaired or repeated member endings, a run ending while members remain open, and every update after a run ending on both cold load and live append.

The workflow package exposes browser-safe run and observation vocabulary through `@deepseek-ai/dsh-workflow/types`; live `Agent` requests and control handles remain Host-only. `@deepseek-ai/dsh-workflow-run-recorder/types` owns the four Session event payloads while retaining the established `tool-workflow/*` event names. Client code imports only these type faces, so the Host and Client TypeScript programs share the durable contract without merging Host Cordis context.

`ui-workflow-run` registers one `workflow-run` Conversation Definition and one keyed Chat renderer. Every event independently yields the same `runId`; run-start initializes State, later events update it in log order, and an update-only history tail remains pending until prepend supplies the unique start. The final node keeps the engine-owned key and anchors at run-start, placing it after the original tool call while preserving one React parent from running through terminal state.

The renderer gives each level a distinct visual responsibility. The run uses a 32-pixel module-platform background row with persistent right/down chevrons and an inline state dot plus status text, without a badge. Phases use 32-pixel disclosure rows with title and member count in the flexible main area and a fixed precise aggregate-status tail, without another dot. Members use a 16-pixel dot slot, a truncating name area, and a fixed 64-pixel status column. Phases exist only when a member actually starts and group by the exact phase string; an omitted phase and the empty string retain distinct identities and localized names. Member settlement changes status without removing or reordering the member. Only a durable logical ending settles a background record; when the loaded Session location closes with a legal unfinished suffix that has no live continuation, the missing ending becomes interrupted presentation. [Status-driven workflow disclosure](2026-08-11-workflow-run-status-driven-disclosure.md) owns which run and phase content remains visible as those facts change.

Navigation is derived from the durable child id plus the current authoritative direct-child catalog. A running or settled member row is interactive only when a refreshed catalog proves the same id is a healthy direct one-shot child of the displayed parent. Underlined member text is the only visible affordance; keyboard focus draws a two-pixel business-primary ring around the name area, and the fixed status label remains the lifecycle word rather than an action instruction. The injected action resolves and opens that catalog address; it never falls back to unchecked `sessions.open(id)`. Diagnostic, continuable, remote, wrong-parent, missing, and stale entries remain visible but static.

The [seven-state Figma reference](https://www.figma.com/design/tguwzZRmHCjbq58mfsqT0M?node-id=5-2) fixes the information hierarchy for running expanded/collapsed, completed history/expanded, failed plus cancelled, interrupted recovery, and dark narrow presentation. Repository `DisclosureRow`, `StateDot`, icons, semantic tokens, and keyed-node behavior remain the implementation authority; the reference introduces no runtime field or state owner.

## Verification

Package tests cover command and tool attribution, nested and unattributed exclusion, stable logical ids across attempts, zero-member and concurrent runs, terminal-disposal-before-ending order, restart reconciliation, legal append-failure prefixes, and cold/live invariant rejection. Conversation tests compare complete replace, update-only prepend, and live append; they cover background work surviving launching-Turn closure, exact phase identity, terminal and interrupted status, disclosure state, catalog-fenced running and settled child navigation, and HMR removal and re-registration. The shipped Web replay exercises the real worker and spawn provider, Session persistence, the later completion turn, terminal retention, original tool-row coexistence, and refresh reconstruction.

## Alternatives considered

**Append workflow content inside the existing tool card.** Rejected because `ui-tool` and the tool definition own that row's presentation and interaction. A workflow-specific appendix would couple two independently keyed business lifecycles and revive the removed post-tool attachment model.

**Build the Chat row from supervisor manifests or its workflow-run Remote.** Rejected because the model-visible Chat record must remain reconstructable from the parent Session log. The bounded Remote owns dashboard inspection and controls; using it as Chat history would create a second durability owner and make replay depend on retained-run eviction.

**Render declared phases or infer a static workflow graph from script text.** Rejected because only member-start events prove work happened. `meta.phases`, `phase()` narration, branches, and script syntax do not describe one authoritative runtime topology.

**Open a child from its durable id alone.** Rejected because historical identity does not prove current accessibility or direct parentage. Both running and settled navigation therefore require the current catalog to authorize the exact healthy one-shot child.

## Consequences

Workflow progress survives refresh and process recovery in the same log as its parent conversation, while the supervisor owns execution and the original tool card remains unchanged. The source-neutral recorder owns four small events and their invariant; first-write failure intentionally sacrifices later observation rather than workflow correctness. Browser State is derived per loaded window, the status-driven disclosure lifecycle keeps review choices local, and navigation can appear or disappear as catalog facts change. The Chat node shows only actual runtime members and statuses, leaving outputs, logs, controls, and retained-run details to the bounded dashboard Remote.

# @deepseek-ai/dsh-client-ui-workflows

English | [中文](README.zh.md)

`dsh-client-ui-workflows` owns the Web workflow run dashboard. It registers `/workflows` as a client-only slash action and renders a full-screen overlay; opening it never executes a Host command and therefore never appends `workflows · Completed` command rows to Chat. It also decorates bare `/workflow` with a session-scoped saved-definition picker; `/workflow ` and argued invocations remain Host `leadingInput` commands.

## Dashboard

The overlay uses three independently scrollable panes on desktop: a live/history run navigator, the selected run's phase and agent roster, and an inspector for agent outcomes, logs, the final result, and scratch artifacts. Medium layouts retain the run navigator plus one drill-down pane. Narrow layouts route explicitly from runs to execution to inspector, with back controls, focus transfer, and viewport-contained scrolling. Run-output controls open logs, the result, or artifacts without requiring an agent row, so zero-agent workflows remain fully inspectable.

Run and member rows contain only bounded summaries. The React-free `WorkflowRunsController` loads the initial retained page and receives revisioned changes; selected-run detail, member pages, one member outcome, logs, the final result, and scratch artifacts load on demand. Collection revisions refetch only the changed collection, selection changes abort stale reads, and bounded pagination never replaces a later selection with an older response.

Log pages report how many older lines were evicted, and artifact pages report how many names were omitted, including when no retained row remains. The dashboard does not describe retention loss as a workflow that never logged or wrote scratch files.

Every member row is selectable. Its inspector distinguishes a still-pending outcome, a complete JSON value, Markdown text, JSON `null`, a bounded preview, a result that was not produced, a retained value that was evicted, and a request failure with retry. Child navigation resolves the exact direct child through the Session catalog before opening it; an outcome does not imply that a transcript is available.

Pause, Resume, Stop, and Save are derived only from the run's `allowedActions`. Buttons and the `p`, `r`, `x`, and `s` shortcuts use the same availability check, including budget-limited resume rejection. The modal takes focus, contains Tab navigation, handles Escape for its full lifetime, makes the underlying shell inert, restores the opener on close, and ignores action shortcuts only while a text-entry descendant owns the key.

## Styling

The dashboard uses CSS Modules and `--dsw-alias-*` tokens only. DeepSeek base and layer surfaces preserve contrast in light and dark themes; status is always communicated by text as well as color. Focus rings, reduced-motion behavior, 44-pixel mobile targets, and 320-pixel overflow defenses are part of the component contract.

## Model Experience

None, as this package renders bounded workflow-run state for humans and adds no prompt, tool schema, request content, or model-visible result.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Retained run manifests recover dashboard history after restart, and any run that was active at shutdown recovers as Interrupted. Live execution handles, journals, and resume authority remain process-local, so cross-process workflow resume is unsupported.

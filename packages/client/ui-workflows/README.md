# @deepseek-ai/dsh-client-ui-workflows

English | [中文](README.zh.md)

Fullscreen workflow-run dashboard: the `/workflows` overlay with a live roster, phase rail, members grouped by started phase, log lines, final result, and Pause/Resume/Stop/Save controls.

## Composition

The plugin registers one `shell.overlay` entry (`kind: list`, root scope) and reads the current session's runs entirely from the `workflowRunsBySession` mirror — the api-proxy's whole-set `session/workflow-runs` frames land in the runtime object layer; the plugin issues no read RPC. The `/workflows` host command returns a bare success and the plugin opens the overlay on the local `command/executed` acknowledgment.

Controls execute host commands through the commands Remote — `/workflow pause|resume|stop|save <display-name>` — so permissions stay with the normal command path, and Save is hidden for built-ins and numbered duplicate handles. Keyboard: `p`/`r`/`x`/`s` with `Escape` to close.

## Styling

Component CSS uses `--dsw-alias-*` semantic tokens from `ui-theme`; desktop and a narrow/mobile stacked layout share one overlay.

## Model Experience

None, as this package renders host-computed supervisor state for a human and touches no prompt, message, schema, stream, or tool result. Controls issue host slash commands through the existing command channel; the model's own view of the same runs stays with [`dsh-workflow-supervisor`](../../workflow/workflow-supervisor/README.md) and the [`workflow` tool](../../workflow/tool-workflow/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Budget-limited resume rejection is surfaced through the command failure text; there is no inline dashboard reason yet.
- The roster lists every retained run for the session with no retention cap or pruning.
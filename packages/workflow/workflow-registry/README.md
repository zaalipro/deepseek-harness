# @deepseek-ai/dsh-workflow-registry

English | [中文](README.zh.md)

Saved-workflow definition registry (`ctx.workflows`): discovers JSON envelope definitions, validates `meta` as data beside the script body, serves sorted summaries and full definitions keyed by `meta.name`, and invalidates on change.

## File format

One repo-consistent envelope: `<name>.workflow.json` under a discovery root.

```json
{ "meta": { "name": "review-changes", "description": "…", "whenToUse": "…",
  "phases": [{ "title": "Review", "detail": "…" }] },
  "script": "// plain JS body, top-level await, complete(value) or return" }
```

The filename must equal `<meta.name>.workflow.json`; `meta.name` is kebab-case. Unknown meta fields fail loud. `meta` is validated as JSON data — the script body is never evaluated.

## Discovery and precedence

| Scope | Root |
|---|---|
| `bundled` | `config.bundledDir` (optional) |
| `project` | `<projectRoot>/.dsh/workflows` |
| `user` | `<dshHome>/workflows` |

`projectRoot` is the nearest ancestor containing `.git` (the cwd when none). Precedence is bundled > project > user; duplicate names resolve to the highest-precedence scope.

## Service contract

`list(options)` returns sorted invocation-neutral summaries. `get(name, options)` loads a full definition (meta + script + path + scope). Lookup is cwd-sensitive and abortable. Each envelope is opened with `ctx.fs.readBytesNoFollow`, so final-link refusal, regular-file validation, and the complete byte-bounded read share one provider object. `save(envelope, options)` uses guarded `ctx.fs.writeTextNoFollow`; create/version validation and final-entry publication remain inside the provider operation, so a substituted final link is never followed. A provider without either guarantee fails loud with `FS_IO_ERROR`. A malformed definition file fails discovery loud with its path and reason. A chokidar watcher invalidates the catalog and emits `workflows/change`.

The generated `workflowDefinitions/list` Remote accepts a session id and optional cancellation signal. The Host resolves that id through the Session lookup, selects discovery only from the resolved session's recorded cwd, and rejects a session without one instead of falling back to the Host process cwd. Its `WorkflowDefinitionSummaryView` result contains only `name`, `description`, optional `whenToUse`, and `scope`; the Remote does not return filesystem paths, phase metadata, or scripts.

## Model Experience

Indirectly, through the [`workflow` tool](../tool-workflow/README.md) and the `/workflow` commands, which resolve `name` against this registry and own any launched run's result.

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- Only the flat `.workflow.json` envelope is read; a directory bundle (`<name>/workflow.json` + `script.js`) is not.
- Full definitions are re-read from disk per `get()`; the registry caches only summaries.
- The local Windows filesystem provider cannot supply atomic final-component no-follow reads or writes. With that provider, discovery and `save()` fail loud with `FS_IO_ERROR`; Windows deployments need a provider with native handle-based equivalents.

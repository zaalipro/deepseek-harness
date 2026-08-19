/**
 * The bundled `create-workflow` authoring skill body: the full procedure plus
 * the JavaScript reference, shipped through the command plugin's bundled provider.
 * The model follows it when `/create-workflow` steers it here; humans find it
 * in the slash menu because the description names the command.
 * @module @deepseek-ai/dsh-command-workflows/skill
 */

export const CREATE_WORKFLOW_SKILL = `# create-workflow

Author a saved workflow: a deterministic JavaScript orchestration script that
fans out subagents. The script — not the model turn — holds the loop, the
fan-out, the branching, and the intermediate results; child agents do the
judgment, the script shards work and verifies.

## Procedure (force these steps, in order)

1. **Gather intent conversationally.** What does it do, what fans out, what is
   verified, the final artifact, and roughly how many agents the user will
   tolerate. Ask before authoring; never guess scope.
2. **Pick name + scope.** Name is at most 64 characters, starts with a
   lowercase letter, and otherwise uses lowercase kebab-case
   (\`^[a-z](?:[a-z0-9]*)(?:-[a-z0-9]+)*$\`). Do not use a control verb
   (\`pause\`, \`resume\`, \`save\`, \`stop\`, \`workflows\`) or a Windows
   device basename. Scope is project
   (\`.dsh/workflows/\`, default, shareable) or user (\`<dshHome>/workflows/\`,
   all projects). When a name collides with another slash command, the existing
   command keeps \`/<name>\` and the saved workflow is advertised as
   \`/workflow-<name>\`; the host repeats the \`workflow-\` prefix if that name
   is also occupied. The canonical \`/workflow <name>\` form always works.
3. **Author the JS workflow.** Shape: meta (plain data) → schemas as constants
   → one section per phase. Agent prompts must be imperative and self-contained
   — command tool use and say what a valid empty answer requires.
4. **Smoke-check ONE path** with \`validate_only: true\` and representative
   \`args\`. Iterate until meta, parse/compile, and that canned-host path pass.
   This does NOT cover every branch, live tools, or schema handling for every
   agent output.
5. **Save** the smoke-checked script to the chosen path (create the directory).
   It is now runnable as \`/<name>\` (or the qualified alias advertised by the
   slash menu after a collision) and as \`/workflow <name> ...\`.
6. **Offer a REAL background run** with representative args; the user watches
   it in \`/workflows\`. If they decline, stop and say only the path-specific
   smoke check ran.
7. **Report:** the file path, the smoke-check output and its limits, how to run
   it, and the max agent fan-out per run.

## File format (one repo-consistent envelope)

\`<name>.workflow.json\` — a JSON envelope; meta is DATA beside the script body,
never evaluated, never \`export const meta\`:

\`\`\`json
{ "meta": { "name": "review-changes", "description": "...", "whenToUse": "...",
  "phases": [{ "title": "Review", "detail": "...", "provider": "", "model": "" }] },
  "script": "// plain JS body, top-level await, complete(value) or return" }
\`\`\`

Filename must equal \`<meta.name>.workflow.json\`. Unknown meta fields fail loud.
\`whenToUse\` is listing-only.

## Script hooks (plain JavaScript)

- \`agent(prompt, opts?): Promise<any>\` — one subagent to completion. Without
  \`opts.schema\` it resolves to final text; with \`opts.schema\` (object-rooted
  JSON Schema: only type/properties/required/additionalProperties/items/enum/
  const/oneOf, plus minItems/maxItems on arrays) it resolves to the validated
  object; a failed child resolves \`null\`. Other opts: \`label\`, \`phase\`,
  \`provider\`, \`model\`. Anything else rejects loudly.
- \`parallel(items): Promise<any[]>\` — barrier. Items are zero-arg functions OR
  job maps \`{ prompt, label?, phase?, schema?, provider?, model? }\`. Failed
  slots resolve \`null\`.
- \`pipeline(items, ...stages): Promise<any[]>\` — per-item stage chains, no
  cross-stage barrier; each stage gets \`(prev, item, index)\`; an ordinary
  throw drops that item to \`null\`.
- \`phase(title)\`, \`log(message)\`, \`args\` — progress, narration, input.
- \`complete(value)\` — end the run successfully with a JSON value. Prefer over
  \`return\`.
- \`await await_user(kind, message)\` — park for a human answer; resume continues
  past it. \`await pause(kind, message)\` — park for a condition resume CANNOT
  change; resume re-fires it. Both hooks are asynchronous and MUST be awaited.
  Kinds: user, back_off, no_progress, verification, infra.
- \`budget(): { total, spent, reserved, remaining }\` — this run's logical agent
  budget. \`await write_scratch_file(name, content)\` / \`await
  read_scratch_file(name)\` — per-run scratch (single-component names).

Misused hooks, unknown options, unsupported schemas, and tripped caps throw
fatal errors that kill the script — never a silent per-item \`null\`.

## Good patterns

- Build the fan-out work-list the simplest deterministic way (a fixed list,
  \`args\`, a file walk). Spend agents on judgment, not on deciding scope.
- If an agent discovers the work-list, treat it as untrusted: re-filter it in
  PLAIN JS against the invariant (e.g. keep only paths under \`args.root\`)
  before sharding.
- Plan → parallel fan-out → synthesize.
- Adversarial verification: independent skeptics prompted to refute each
  finding. Missing/failed/unusable verification is NOT a confirming vote;
  require concrete evidence.
- Loop until dry: spawn finders until two consecutive rounds surface nothing
  new; fingerprint each round to detect stalls.
- Vote panels: N skeptics per item in one flat \`parallel()\`, regroup by index
  arithmetic.
- Failure policy by purpose: optional advice may fail open; a proof gate fails
  closed.

## Pitfalls that actually happen — encode them

- Terse prompts return empty structured objects without using tools. Command
  tool use; say what a valid empty answer requires.
- Guard every agent output against the schema value itself: for example,
  \`r != null && Array.isArray(r.findings)\`. A schema-backed \`agent()\` returns
  that structured object directly; failed \`parallel()\` slots are \`null\`.
- Meta is pure data — no computed meta.
- Keep \`meta.phases\` titles in sync with \`phase()\` calls.
- \`pause()\` in a result-derived branch re-fires forever; use \`await_user\`
  for resumable human gates.
- Silent truncation is not coverage; \`log()\` whatever a \`MAX_*\` cap dropped.
- Agents do not enforce invariants — the script does. Filter/assert in JS.

## Example (review-changes)

\`\`\`js
const findingsSchema = { type: "object", required: ["findings"],
  properties: { findings: { type: "array", maxItems: 8,
    items: { type: "object", required: ["file", "issue"],
      properties: { file: { type: "string" }, issue: { type: "string" } } } } } };
const verdictSchema = { type: "object", required: ["real", "reason", "evidence"],
  properties: { real: { type: "boolean" }, reason: { type: "string" },
    evidence: { type: "string" } } };

const target = args && args.target;
if (target == null) await pause("verification", "Pass args.target — the diff, branch, or path to review.");

phase("Review");
const dimensions = ["correctness bugs", "error handling gaps", "performance problems"];
const results = await parallel(dimensions.map((d) => async () => await agent(
  "Review " + target + " for " + d + ". Use read-only tools to inspect the actual code — " +
  "do not answer from memory. Report at most 8 concrete findings as {file, issue}; " +
  "an empty list is valid only after you have read the code.",
  { label: "review:" + d, schema: findingsSchema })));

const findings = [];
for (const r of results) {
  if (r != null && Array.isArray(r.findings)) for (const f of r.findings) findings.push(f);
}
if (findings.length === 0) complete({ summary: "No findings.", confirmed: [] });

phase("Verify");
const verdicts = await parallel(findings.map((f) => async () => await agent(
  "Adversarially verify this review finding by reading the shipped code: \\"" +
  f.issue + "\\" in " + f.file + ". Set real=true only with concrete evidence you " +
  "independently inspected. Otherwise default real=false.",
  { label: "verify:" + f.file, schema: verdictSchema })));

const confirmed = [];
for (let i = 0; i < verdicts.length; i++) {
  const v = verdicts[i];
  if (v != null && v.real === true && v.evidence) confirmed.push(findings[i]);
}
log(String(confirmed.length) + "/" + String(findings.length) + " findings survived verification");
complete({ summary: String(confirmed.length) + " confirmed findings", confirmed });
\`\`\``

/** The skill's one-line description; names `/create-workflow` so the slash menu and the model both find it. */
export const CREATE_WORKFLOW_DESCRIPTION = 'Author, smoke-check, and save a new saved workflow (invoke via /create-workflow).'

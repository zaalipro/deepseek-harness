# @deepseek-ai/dsh-workflow-user-questions

English | [中文](README.zh.md)

Human-input Consumer for supervised workflows. The shared base composition mounts this plugin beside `ctx.workflowSupervisor` and `ctx.userQuestions`. Web supplies the active question provider and presents workflow gates in the browser; a headless profile has no provider, so the request fails loud and the workflow remains parked until one-shot owner disposal interrupts it rather than holding the process open.

## Behavior

Each current `workflows/gate-request` opens one question in the run's exact parent Session. The question shows the workflow display name and script-provided message, with a **Resume workflow** acknowledgement. An accepted answer calls `resumeGate()` with the logical-run id, engine-execution id, gate id, and exact parent Agent, so an answer delayed past stop, manual resume, attempt replacement, owner teardown, or service teardown cannot resume another execution.

`await_user()` continues past its gate after the answer. `pause()` executes the same call again after resume and therefore presents another question while its condition remains unchanged. Closing the question leaves the run in **Needs input**; it does not stop or resume the workflow.

The supervisor's request signal withdraws the question when the addressed gate ceases to be current. Plugin teardown also aborts and awaits every pending question before its fiber settles.

## Model Experience

### Workflow input acknowledgement

#### What the model sees

Nothing directly from `workflows/gate-request`. The workflow script remains parked while the question is visible; the workflow tool and supervisor own any later result or completion notice.

#### Token effect

Zero direct token effect. The acknowledgement is not appended to model history and its text is not returned to the script.

#### KV Cache effect

None. Presenting or answering the question does not change a model request prefix.

## Known Limitations and Deferred Work

- **Answers acknowledge rather than supply script data** — `await_user()` and `pause()` return no answer value, so scripts must collect mutable input before launch and use these hooks only for human checkpoints.
- **Dismissal does not recreate the composer request** — closing a question keeps the run parked; the user resumes from the dashboard or slash control unless the workflow emits another gate occurrence.

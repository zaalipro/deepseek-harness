import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const workflowLaunchIdle = Promise.withResolvers<true>()
let workflowParentSession: string | undefined
let releaseWorkflowChildAtIdle = false

function* textReply(text: string, inputTokens: number, outputTokens: number): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens, outputTokens } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Keyless headless-agent adapter for the product CLI and workflow-drain snapshots. */
class CliMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    if (process.env.DSH_CLI_MOCK_WORKFLOW === '1' && options.purpose !== 'session-title') {
      if (options.sessionId === undefined) throw new Error('CLI workflow mock requires a Session id')
      const sessionId = String(options.sessionId)
      workflowParentSession ??= sessionId
      if (sessionId !== workflowParentSession) {
        await workflowLaunchIdle.promise
        yield* textReply('WF_CHILD_OK', 3, 1)
        return
      }

      const lastMessage = options.messages.at(-1)
      if (lastMessage?.source.kind === 'plugin'
        && lastMessage.source.plugin === 'workflow-supervisor') {
        yield* textReply('WORKFLOW_COMPLETION_ACK', 7, 2)
        return
      }
      const workflowResult = lastMessage?.content.find(block => block.type === 'tool-result')
      if (workflowResult !== undefined) {
        releaseWorkflowChildAtIdle = true
        yield* textReply('WORKFLOW_LAUNCHED', 5, 2)
        return
      }

      const args = JSON.stringify({
        meta: { name: 'headless-drain', description: 'prove the one-shot workflow drain' },
        script: "phase('Run')\nconst reply = await agent('Reply with exactly WF_CHILD_OK and nothing else.')\ncomplete({ reply })",
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('cli-workflow-call'), name: 'workflow', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('cli-workflow-call'), name: 'workflow', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ command: 'printf CLI_TOOL_ROUND_TRIP', description: 'Prove the CLI tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('cli-smoke-call'), name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('cli-smoke-call'), name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `CLI tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.on('agent/status', ({ agent, status }) => {
    if (!releaseWorkflowChildAtIdle || status !== 'idle' || String(agent.id) !== workflowParentSession) return
    releaseWorkflowChildAtIdle = false
    workflowLaunchIdle.resolve(true)
  })
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}

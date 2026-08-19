/** `workflows` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'workflows'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  title: '工作流',
  close: '关闭工作流面板',
  'empty.title': '还没有工作流运行',
  'empty.body': '用 /workflow <名称> 或 /<名称> 启动一个已保存的工作流；它的实时运行会出现在这里。',
  'phase.rail.aria': '阶段轨道',
  'members.aria': '代理名册',
  'logs.aria': '日志行',
  'result.aria': '最终结果',
  'progress.label': '个代理',
  'status.running': '运行中',
  'status.needs-input': '等待输入',
  'status.paused': '已暂停',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.cancelled': '已停止',
  'status.interrupted': '已中断',
  'member.running': '运行中',
  'member.completed': '完成',
  'member.failed': '失败',
  'member.cancelled': '已停止',
  'control.pause': '暂停',
  'control.resume': '继续',
  'control.stop': '停止',
  'control.save': '保存',
  'kbd.hint': 'p 暂停 · r 继续 · x 停止 · s 保存 · esc 关闭',
} as const

/** The `workflows` dictionary key union. */
export type WorkflowsKey = keyof typeof zh

/** English dictionary (key-set matched to `zh`). */
export const en: Record<WorkflowsKey, string> = {
  title: 'Workflows',
  close: 'Close workflow dashboard',
  'empty.title': 'No workflow runs yet',
  'empty.body': 'Launch a saved workflow with /workflow <name> or /<name>; its live run appears here.',
  'phase.rail.aria': 'Phase rail',
  'members.aria': 'Agent roster',
  'logs.aria': 'Log lines',
  'result.aria': 'Final result',
  'progress.label': 'agents',
  'status.running': 'Running',
  'status.needs-input': 'Needs input',
  'status.paused': 'Paused',
  'status.completed': 'Completed',
  'status.failed': 'Failed',
  'status.cancelled': 'Stopped',
  'status.interrupted': 'Interrupted',
  'member.running': 'Running',
  'member.completed': 'Done',
  'member.failed': 'Failed',
  'member.cancelled': 'Stopped',
  'control.pause': 'Pause',
  'control.resume': 'Resume',
  'control.stop': 'Stop',
  'control.save': 'Save',
  'kbd.hint': 'p pause · r resume · x stop · s save · esc close',
}

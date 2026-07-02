import type { RefKind } from '../types';
import type { ToolSchema } from '../llm/types';

const PREDICT_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description:
    '可选：对执行后可观察变化的预期（如 "control:c: 0 → 5"、"url: /a → /b"、"surface s changed"）。' +
    '命中则连续执行你本回合后续步骤，落空会停下让你按真实结果重规划——仅加速，猜错不算失败、不改结果。',
};

const refParam = (desc: string) => ({
  type: 'object',
  properties: { ref: { type: 'string', description: desc }, predict: PREDICT_PARAM },
  required: ['ref'],
  additionalProperties: false,
});

export const FINISH_TOOL: ToolSchema = {
  name: 'finish',
  description: '结束并给出用户可见的最终回答。',
  parameters: {
    type: 'object',
    properties: {
      answer: {
        type: 'string',
        description:
          '给用户的最终回答：专注回答问题、转述你读到的内容、给出你的判断。' +
          '系统会自动附上由证据账本生成的执行记录，你不必逐项复述执行统计。',
      },
      goalMet: {
        type: 'boolean',
        description:
          '任务目标是否真正达成。若页面反馈显示操作在业务上失败或被拒绝（如错误提示），' +
          '置 false 并在 answer 里说明——这只会把结果如实降级为 failed；置 true 不能掩盖账本里的失败。',
      },
    },
    required: ['answer'],
    additionalProperties: false,
  },
};

export const READ_LOOP_TOOLS: ToolSchema[] = [
  {
    name: 'observePage',
    description: '读取当前页面的契约快照（对象/动作/控件/区域）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  { name: 'readSurface', description: '读取某个 surface 区域的文本内容。', parameters: refParam('surface 的 ref id') },
  { name: 'openObject', description: '打开/选中一个对象以查看更多。', parameters: refParam('object 的 ref id') },
  { name: 'navigate', description: '跳转到某个对象的详情/位置。', parameters: refParam('object 的 ref id') },
  FINISH_TOOL,
];

export const REF_TOOL_KINDS: Record<string, RefKind> = {
  readSurface: 'surface',
  openObject: 'object',
  navigate: 'object',
};

export const WRITE_TOOLS: ToolSchema[] = [
  {
    name: 'setControl',
    description: '设置一个控件的值。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'control 的 ref id' },
        value: { type: 'string', description: '要设置的值' },
        predict: PREDICT_PARAM,
      },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'invokeAction',
    description: '触发一个动作（高危需确认）。若该动作声明了参数，用 args 传入。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'action 的 ref id' },
        args: { type: 'object', description: '动作参数（仅当该动作声明了参数时）', additionalProperties: true },
        predict: PREDICT_PARAM,
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
];

export const WRITE_REF_KINDS: Record<string, RefKind> = {
  setControl: 'control',
  invokeAction: 'action',
};

export const ACT_TOOLS: ToolSchema[] = [...READ_LOOP_TOOLS, ...WRITE_TOOLS];

/** Code-as-Action：一次性交出一段程序（JSON AST）来完成多步/写操作。 */
export const RUN_PROGRAM_TOOL: ToolSchema = {
  name: 'runProgram',
  description:
    '一次性提交一段程序（JSON AST）来完成多步/写操作。program = { body: Node[] }；' +
    'Node.op ∈ observe/forEach/if/open/read/setControl/invoke/finish。' +
    'forEach{query:{type?,labelContains?},as,do}; if{cond:{surface,contains},then,else?}; ' +
    'open{on:"$var"}; read{surface}; setControl{on:{control},value}; invoke{action,args?}; finish{answer}。' +
    'invoke/setControl 可选带 predict:string[]（对执行后可观察变化的预期，如 "control:c: 0 → 5"、"url: /a → /b"）——' +
    '仅用于加速校验，猜错不影响结果、也不算失败。' +
    '只能引用页面真实暴露的对象/动作/控件/区域名；高危动作会暂停等确认。',
  parameters: {
    type: 'object',
    properties: {
      program: {
        type: 'object',
        description: '程序 AST：{ body: Node[] }',
        properties: { body: { type: 'array', items: { type: 'object' } } },
        required: ['body'],
      },
    },
    required: ['program'],
    additionalProperties: false,
  },
};

/** Code-as-Action 模式的 act 工具集：只有 runProgram 与 finish。 */
export const PROGRAM_ACT_TOOLS: ToolSchema[] = [RUN_PROGRAM_TOOL, FINISH_TOOL];

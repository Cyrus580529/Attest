import type { RefKind } from '../types';
import type { ToolSchema } from '../llm/types';

const refParam = (desc: string) => ({
  type: 'object',
  properties: { ref: { type: 'string', description: desc } },
  required: ['ref'],
  additionalProperties: false,
});

export const READ_LOOP_TOOLS: ToolSchema[] = [
  {
    name: 'observePage',
    description: '读取当前页面的契约快照（对象/动作/控件/区域）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  { name: 'readSurface', description: '读取某个 surface 区域的文本内容。', parameters: refParam('surface 的 ref id') },
  { name: 'openObject', description: '打开/选中一个对象以查看更多。', parameters: refParam('object 的 ref id') },
  { name: 'navigate', description: '跳转到某个对象的详情/位置。', parameters: refParam('object 的 ref id') },
  {
    name: 'finish',
    description: '结束并给出用户可见的最终回答。',
    parameters: {
      type: 'object',
      properties: { answer: { type: 'string', description: '给用户的最终回答' } },
      required: ['answer'],
      additionalProperties: false,
    },
  },
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
      },
      required: ['ref', 'value'],
      additionalProperties: false,
    },
  },
  { name: 'invokeAction', description: '触发一个动作（高危需确认）。', parameters: refParam('action 的 ref id') },
];

export const WRITE_REF_KINDS: Record<string, RefKind> = {
  setControl: 'control',
  invokeAction: 'action',
};

export const ACT_TOOLS: ToolSchema[] = [...READ_LOOP_TOOLS, ...WRITE_TOOLS];

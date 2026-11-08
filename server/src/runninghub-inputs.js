import { z } from 'zod';

const nodeId = z.string().regex(/^\d+(?::\d+)*$/);
export const runningHubSchema = z.object({
  inputs: z.array(z.object({
    id: z.string().min(1), nodeId, field: z.string().min(1), label: z.string().trim().min(1),
    type: z.enum(['text', 'image']), required: z.boolean(), defaultValue: z.string().optional(),
  })),
  outputNodes: z.array(nodeId).min(1),
}).superRefine((value, ctx) => {
  if (new Set(value.inputs.map((item) => item.id)).size !== value.inputs.length ||
      new Set(value.inputs.map((item) => JSON.stringify([item.nodeId, item.field]))).size !== value.inputs.length ||
      new Set(value.outputNodes).size !== value.outputNodes.length) ctx.addIssue({ code: 'custom', message: '输入映射或输出节点重复' });
  if (value.inputs.some((item) => item.type === 'image' && item.defaultValue !== undefined)) ctx.addIssue({ code: 'custom', message: '图片默认值请保留在云端工作流中' });
});

export function resolveRunningHubBindings(mapping, node, snapshot) {
  const parsed = runningHubSchema.safeParse(mapping);
  if (!parsed.success) throw Object.assign(new Error('请管理员重新读取工作流并保存动态输入映射'), { statusCode: 400 });
  const values = {}, references = [];
  for (const input of parsed.data.inputs) {
    const binding = node.metadata?.runninghubBindings?.[input.id];
    let value = binding?.mode === 'text' && input.type === 'text' ? binding.value : undefined;
    if (binding?.mode === 'node') {
      const source = snapshot.nodes.find((item) => item.id === binding.nodeId);
      if (!source || source.type !== input.type || !snapshot.connections.some((edge) => edge.fromNodeId === source.id && edge.toNodeId === node.id)) {
        throw Object.assign(new Error(`「${input.label}」绑定的节点已删除、类型不符或连线断开`), { statusCode: 400 });
      }
      if (input.type === 'image') {
        let index = references.findIndex((reference) => reference.nodeId === source.id);
        if (index < 0) { index = references.length; references.push({ nodeId: source.id, storageKey: source.metadata?.storageKey }); }
        value = { imageIndex: index };
      } else value = source.metadata?.content ?? '';
    }
    if (value === undefined && input.defaultValue !== undefined) value = input.defaultValue;
    if (input.required && (value === undefined || (typeof value === 'string' && !value.trim()))) {
      throw Object.assign(new Error(`请填写或绑定「${input.label}」`), { statusCode: 400 });
    }
    if (value !== undefined) values[input.id] = value;
  }
  return { values, references };
}

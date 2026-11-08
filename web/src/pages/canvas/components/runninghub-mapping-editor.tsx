import { Button, Input, Select, Switch } from "antd";
import type { RunningHubMapping, RunningHubWorkflow } from "@/services/api/runninghub";

export function RunningHubMappingEditor({ value, onChange, workflow }: {
    value?: RunningHubMapping; onChange?: (value: RunningHubMapping) => void; workflow: RunningHubWorkflow | null;
}) {
    const inputs = value?.inputs || [];
    const update = (next: RunningHubMapping["inputs"]) => onChange?.({ inputs: next, outputNodes: value?.outputNodes || [] });
    return <div className="space-y-3">
        <p>默认只开放图片和明确的提示词。非必填项留空时保留云端原值；移除输入不会删除云端节点。</p>
        {inputs.map((input, index) => {
            const patch = (fields: Partial<typeof input>) => update(inputs.map((item, i) => i === index ? { ...item, ...fields } : item));
            return <div key={index} className="space-y-2 border-b border-current/15 pb-3">
                <div className="flex gap-2"><Input aria-label="输入名称" placeholder="输入名称，如人物图片" value={input.label} onChange={(event) => patch({ label: event.target.value })} />
                    <Button onClick={() => update(inputs.filter((_, i) => i !== index))}>移除</Button></div>
                <div className="flex flex-wrap gap-2">
                    <Select aria-label="输入类型" value={input.type} options={[{ value: "text", label: "文本" }, { value: "image", label: "图片" }]} onChange={(type) => patch({ type, defaultValue: undefined })} />
                    <Input className="!w-28" aria-label="输入节点 ID" placeholder="节点 ID" value={input.nodeId} onChange={(event) => patch({ nodeId: event.target.value })} />
                    <Input className="!w-28" aria-label="输入字段" placeholder="字段" value={input.field} onChange={(event) => patch({ field: event.target.value })} />
                    <label>必填 <Switch size="small" checked={input.required} onChange={(required) => patch({ required })} /></label>
                </div>
                {input.type === "text" && <>
                    <label><input type="checkbox" checked={input.defaultValue !== undefined} onChange={(event) => patch({ defaultValue: event.target.checked ? "" : undefined })} /> 使用自定义默认文本（关闭则保留云端原值）</label>
                    {input.defaultValue !== undefined && <Input.TextArea aria-label="默认文本" value={input.defaultValue} onChange={(event) => patch({ defaultValue: event.target.value })} autoSize />}
                </>}
            </div>;
        })}
        {!inputs.length && <p>未开放输入，可直接运行云端工作流。</p>}
        <Button onClick={() => update([...inputs, { id: crypto.randomUUID(), nodeId: "", field: "", label: "", type: "text", required: false }])}>添加输入 / 特殊节点映射</Button>
        {workflow && <Select className="w-full" value={undefined} placeholder="从识别结果添加输入" options={[...workflow.images.map((item) => ({ ...item, type: "image" as const })), ...workflow.prompts.map((item) => ({ ...item, type: "text" as const }))].filter((item) => !inputs.some((input) => input.nodeId === item.nodeId && input.field === item.field)).map((item) => ({ value: JSON.stringify(item), label: item.label }))} onChange={(value) => {
            const item = JSON.parse(value);
            update([...inputs, { id: `${item.nodeId}/${item.field}`, nodeId: item.nodeId, field: item.field, label: item.label, type: item.type, required: item.type === "image" }]);
        }} />}
        {Boolean(workflow?.advancedTexts.length) && <details className="space-y-2">
            <summary className="cursor-pointer">高级文本候选（{workflow!.advancedTexts.length} 项）</summary>
            <p>这些普通字符串可能是固定指令或拼接片段，默认保留云端配置。确认需要每次修改后再添加；运算和展示字段已过滤。</p>
            <Select className="w-full" value={undefined} placeholder="选择要开放的文本" options={workflow!.advancedTexts.filter((item) => !inputs.some((input) => input.nodeId === item.nodeId && input.field === item.field)).map((item) => ({ value: JSON.stringify(item), label: item.label }))} onChange={(value) => {
                const item = JSON.parse(value);
                update([...inputs, { id: `${item.nodeId}/${item.field}`, nodeId: item.nodeId, field: item.field, label: item.label, type: "text", required: false }]);
            }} />
        </details>}
        <label className="block">图片输出节点（可多选）<Select className="w-full" mode="tags" aria-label="图片输出节点" placeholder="选择或输入节点 ID" value={value?.outputNodes || []} options={workflow?.outputs.map((item) => ({ value: item.nodeId, label: item.label }))} onChange={(outputNodes) => onChange?.({ inputs, outputNodes })} /></label>
    </div>;
}

import { Button, Checkbox, Input, Select, Switch, theme } from "antd";
import { useEffect, useState } from "react";
import type { RunningHubMapping, RunningHubWorkflow } from "@/services/api/runninghub";

export function RunningHubMappingEditor({ value, onChange, workflow }: {
    value?: RunningHubMapping; onChange?: (value: RunningHubMapping) => void; workflow: RunningHubWorkflow | null;
}) {
    const { token } = theme.useToken();
    const [removed, setRemoved] = useState<RunningHubMapping["inputs"]>([]);
    useEffect(() => setRemoved([]), [workflow]);
    const inputs = value?.inputs || [];
    const outputs = value?.outputNodes || [];
    const restorable = removed.filter(item => !inputs.some(input => input.id === item.id || (input.nodeId === item.nodeId && input.field === item.field)));
    const update = (next: RunningHubMapping["inputs"]) => onChange?.({ inputs: next, outputNodes: outputs });
    return <div className="space-y-5">
        <section aria-label="输入配置" className="space-y-3 rounded-xl border p-4" style={{ borderColor: token.colorBorderSecondary, background: token.colorFillAlter }}>
        <div className="flex items-center justify-between font-semibold"><span>输入</span><span style={{ color: token.colorTextSecondary }}>{inputs.length} 项</span></div>
        {inputs.map((input, index) => {
            const suffix = `（${input.nodeId}） · ${input.field}`;
            const name = input.label.endsWith(suffix) ? input.label.slice(0, -suffix.length).trimEnd() : input.label;
            const patch = (fields: Partial<typeof input>) => update(inputs.map((item, i) => i === index ? { ...item, label: name, ...fields } : item));
            const colors = input.type === "image"
                ? { background: token.colorSuccessBg, borderColor: token.colorSuccessBorder }
                : { background: token.colorWarningBg, borderColor: token.colorWarningBorder };
            return <div key={input.id} className="space-y-3 rounded-lg border p-3" style={colors}>
                <div className="text-xs font-semibold" style={{ color: input.type === "image" ? token.colorSuccessText : token.colorWarningText }}>{input.type === "image" ? "图片" : "文本"}输入 · {index + 1}</div>
                <div className="flex gap-2"><Input aria-label="输入名称" placeholder="输入名称，如人物图片" value={name} onChange={(event) => patch({ label: event.target.value })} />
                    <Button onClick={() => {
                        setRemoved(previous => [...previous.filter(item => item.id !== input.id), { ...input }]);
                        update(inputs.filter((_, i) => i !== index));
                    }}>移除</Button></div>
                <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-24 flex-1 space-y-1"><div className="text-xs">类型</div><Select className="w-full" aria-label="输入类型" value={input.type} options={[{ value: "text", label: "文本" }, { value: "image", label: "图片" }]} onChange={(type) => patch({ type, defaultValue: undefined })} /></div>
                    <div className="min-w-24 flex-1 space-y-1"><div className="text-xs">节点 ID</div><Input aria-label="输入节点 ID" placeholder="节点 ID" value={input.nodeId} onChange={(event) => patch({ nodeId: event.target.value })} /></div>
                    <div className="min-w-24 flex-1 space-y-1"><div className="text-xs">字段</div><Input aria-label="输入字段" placeholder="字段" value={input.field} onChange={(event) => patch({ field: event.target.value })} /></div>
                    <label className="flex h-8 items-center gap-2">必填 <Switch size="small" checked={input.required} onChange={(required) => patch({ required })} /></label>
                </div>
                {input.type === "text" && <>
                    <Checkbox checked={input.defaultValue !== undefined} onChange={(event) => patch({ defaultValue: event.target.checked ? "" : undefined })}>自定义默认文本</Checkbox>
                    {input.defaultValue !== undefined && <Input.TextArea aria-label="默认文本" value={input.defaultValue} onChange={(event) => patch({ defaultValue: event.target.value })} autoSize />}
                </>}
            </div>;
        })}
        {!inputs.length && <p>暂无输入</p>}
        {restorable.length > 0 && <div className="space-y-2 rounded-lg border border-dashed p-3" style={{ borderColor: token.colorBorder }}>
            <div className="text-sm font-semibold">已移除输入</div>
            {restorable.map(item => <div key={item.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 break-words">{item.label || `${item.type === "image" ? "图片" : "文本"}（${item.nodeId || "未设置节点"}）`}</span>
                <Button size="small" onClick={() => {
                    update([...inputs, item]);
                    setRemoved(previous => previous.filter(entry => entry.id !== item.id));
                }}>恢复</Button>
            </div>)}
        </div>}
        <Button onClick={() => update([...inputs, { id: crypto.randomUUID(), nodeId: "", field: "", label: "", type: "text", required: false }])}>添加输入</Button>
        {workflow && <Select className="w-full" value={null} placeholder="从识别结果添加输入" options={[...workflow.images.map((item) => ({ ...item, type: "image" as const })), ...workflow.prompts.map((item) => ({ ...item, type: "text" as const }))].filter((item) => !inputs.some((input) => input.nodeId === item.nodeId && input.field === item.field)).map((item) => ({ value: JSON.stringify(item), label: item.label }))} onChange={(value) => {
            const item = JSON.parse(value);
            update([...inputs, { id: `${item.nodeId}/${item.field}`, nodeId: item.nodeId, field: item.field, label: item.label, type: item.type, required: item.type === "image" }]);
        }} />}
        {Boolean(workflow?.advancedTexts.length) && <details className="space-y-2">
            <summary className="cursor-pointer">高级文本候选（{workflow!.advancedTexts.length} 项）</summary>
            <Select className="w-full" value={null} placeholder="选择要开放的文本" options={workflow!.advancedTexts.filter((item) => !inputs.some((input) => input.nodeId === item.nodeId && input.field === item.field)).map((item) => ({ value: JSON.stringify(item), label: item.label }))} onChange={(value) => {
                const item = JSON.parse(value);
                update([...inputs, { id: `${item.nodeId}/${item.field}`, nodeId: item.nodeId, field: item.field, label: item.label, type: "text", required: false }]);
            }} />
        </details>}
        </section>
        <section aria-label="输出配置" className="space-y-3 rounded-xl border p-4" style={{ borderColor: token.colorInfoBorder, background: token.colorInfoBg }}>
        <div className="flex items-center justify-between font-semibold"><span>输出</span><span style={{ color: token.colorTextSecondary }}>{outputs.length} 项</span></div>
        <div className="rounded-lg border p-3" style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}>
        <label className="block space-y-1"><span>图片节点</span><Select className="w-full" mode="tags" aria-label="图片输出节点" placeholder="选择或输入输出节点 ID（可多选）" value={outputs} options={workflow?.outputs.map((item) => ({ value: item.nodeId, label: item.label }))} onChange={(outputNodes) => onChange?.({ inputs, outputNodes })} /></label>
        </div>
        </section>
    </div>;
}

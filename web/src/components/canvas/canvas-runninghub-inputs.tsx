import { useEffect } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { RunningHubMapping } from "@/services/api/runninghub";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function CanvasRunningHubInputs({ node, mapping, incomingNodes, disabled, onChange }: {
    node: CanvasNodeData; mapping?: RunningHubMapping; incomingNodes: CanvasNodeData[]; disabled: boolean;
    onChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const bindings = node.metadata?.runninghubBindings || {};
    useEffect(() => {
        if (disabled || !mapping?.inputs) return;
        const next = { ...bindings };
        for (const input of mapping.inputs) {
            const sources = incomingNodes.filter((source) => source.type === input.type);
            if (!next[input.id] && sources.length === 1 && mapping.inputs.filter((item) => item.type === input.type).length === 1) next[input.id] = { mode: "node", nodeId: sources[0].id };
        }
        if (JSON.stringify(next) !== JSON.stringify(bindings)) onChange(node.id, { runninghubBindings: next });
    }, [mapping, incomingNodes, disabled, node.id, bindings, onChange]);
    if (!mapping?.inputs) return <p className="mb-2 text-xs">请管理员重新读取工作流并保存动态输入映射。</p>;
    const style = { background: theme.node.fill, color: theme.node.text, borderColor: theme.node.stroke };
    return <div className="mb-2 shrink-0 space-y-2 text-xs" onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
        {!mapping.inputs.length && <p>此工作流无需外部输入，可直接运行。</p>}
        {mapping.inputs.map((input) => {
            const binding = bindings[input.id];
            const sources = incomingNodes.filter((source) => source.type === input.type);
            const missing = binding?.mode === "node" && !sources.some((source) => source.id === binding.nodeId);
            const set = (value: NonNullable<CanvasNodeMetadata["runninghubBindings"]>[string]) => onChange(node.id, { runninghubBindings: { ...bindings, [input.id]: value } });
            return <label key={input.id} className="block space-y-1">
                <span>{input.label}{input.required ? " *" : "（可选）"}</span>
                <select aria-label={input.label} className="min-h-8 w-full min-w-0 rounded border px-1" style={style} disabled={disabled} value={binding?.mode === "node" ? `node:${binding.nodeId}` : binding?.mode || "default"} onChange={(event) => set(event.target.value.startsWith("node:") ? { mode: "node", nodeId: event.target.value.slice(5) } : event.target.value === "text" ? { mode: "text", value: "" } : { mode: "default" })}>
                    <option value="default">{input.defaultValue !== undefined ? "使用默认文本" : input.required ? "请选择输入" : "保留工作流原值"}</option>
                    {input.type === "text" && <option value="text">直接填写文本</option>}
                    {missing && <option value={`node:${binding.nodeId}`} disabled>绑定已断开，请重新选择</option>}
                    {sources.map((source) => <option key={source.id} value={`node:${source.id}`}>{source.title || (input.type === "image" ? "图片" : "文本")} · {source.id.slice(-6)}</option>)}
                </select>
                {binding?.mode === "text" && <textarea aria-label={`${input.label}内容`} className="w-full resize-y rounded border p-1" style={style} disabled={disabled} rows={2} value={binding.value} onChange={(event) => set({ mode: "text", value: event.target.value })} />}
                {!sources.length && <span style={{ color: theme.node.muted }}>可先连接{input.type === "image" ? "空图片" : "文本"}节点，再选择绑定。</span>}
            </label>;
        })}
    </div>;
}

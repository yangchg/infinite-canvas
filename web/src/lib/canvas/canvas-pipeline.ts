import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";

export type PipelineStep = { nodeId: string; targetId?: string };

// Only the selected replacement output continues execution. New outputs are terminal.
export function planPipeline(entryId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): PipelineStep[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.get(entryId)?.type !== CanvasNodeType.Pipeline) throw new Error("流水线入口不存在。");
    const downstream = (id: string) => [...new Set(connections.filter((edge) => edge.fromNodeId === id).map((edge) => edge.toNodeId))];
    const roots = downstream(entryId);
    if (!roots.length) throw new Error("请先将流水线连接到生成配置节点。");
    const steps = new Map<string, PipelineStep>();
    const successors = new Map<string, string[]>();
    const visiting = new Set<string>();
    const outputOwners = new Map<string, string>();
    const visit = (id: string) => {
        if (visiting.has(id)) throw new Error("流水线存在循环连线，请断开循环后重试。");
        if (steps.has(id)) return;
        const node = byId.get(id);
        if (node?.type !== CanvasNodeType.Config || (node.metadata?.generationMode || "image") !== "image") throw new Error("流水线目前仅支持图片生成配置节点。");
        const targetId = node.metadata?.replacementOutputId || undefined;
        const next: string[] = [];
        if (targetId) {
            const target = byId.get(targetId);
            if (target?.type !== CanvasNodeType.Image || !downstream(id).includes(targetId)) throw new Error(`「${node.title}」的替换目标已失效，请重新选择。`);
            if (outputOwners.has(targetId) && outputOwners.get(targetId) !== id) throw new Error("多个步骤不能替换同一个输出图片，请明确输出归属。");
            outputOwners.set(targetId, id);
            next.push(...downstream(targetId).filter((child) => byId.get(child)?.type === CanvasNodeType.Config));
        }
        visiting.add(id);
        // Mark after descendants so cycles cannot be mistaken for shared dependencies.
        for (const child of next) visit(child);
        visiting.delete(id);
        steps.set(id, { nodeId: id, targetId });
        successors.set(id, next);
    };
    roots.forEach(visit);
    const indegree = new Map([...steps.keys()].map((id) => [id, 0]));
    successors.forEach((ids) => ids.forEach((id) => indegree.set(id, indegree.get(id)! + 1)));
    const ready = [...steps.keys()].filter((id) => indegree.get(id) === 0);
    const result: PipelineStep[] = [];
    for (let index = 0; index < ready.length; index++) {
        const id = ready[index];
        result.push(steps.get(id)!);
        for (const child of successors.get(id) || []) {
            indegree.set(child, indegree.get(child)! - 1);
            if (indegree.get(child) === 0) ready.push(child);
        }
    }
    return result;
}

export async function executePipeline(steps: PipelineStep[], signal: AbortSignal, execute: (step: PipelineStep, index: number) => Promise<boolean>) {
    for (let index = 0; index < steps.length; index++) {
        signal.throwIfAborted();
        const success = await execute(steps[index], index);
        signal.throwIfAborted();
        if (!success) throw new Error(`第 ${index + 1} 步未成功，流水线已停止。`);
    }
}

// Only the selected replacement output continues execution. New outputs are terminal.
export function planPipeline(entryId, nodes, connections) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    if (byId.get(entryId)?.type !== "pipeline") throw new Error("流水线入口不存在。");
    const downstream = (id) => [...new Set(connections.filter((edge) => edge.fromNodeId === id).map((edge) => edge.toNodeId))];
    const roots = downstream(entryId);
    if (!roots.length) throw new Error("请先将流水线连接到生成配置节点。");
    const steps = new Map();
    const successors = new Map();
    const visiting = new Set();
    const outputOwners = new Map();
    const visit = (id) => {
        if (visiting.has(id)) throw new Error("流水线存在循环连线，请断开循环后重试。");
        if (steps.has(id)) return;
        const node = byId.get(id);
        if (node?.type !== "config" || (node.metadata?.generationMode || "image") !== "image") throw new Error("流水线目前仅支持图片生成配置节点。");
        const targetId = node.metadata?.replacementOutputId || undefined;
        const next = [];
        if (targetId) {
            const target = byId.get(targetId);
            if (target?.type !== "image" || !downstream(id).includes(targetId)) throw new Error(`「${node.title}」的替换目标已失效，请重新选择。`);
            if (outputOwners.has(targetId) && outputOwners.get(targetId) !== id) throw new Error("多个步骤不能替换同一个输出图片，请明确输出归属。");
            outputOwners.set(targetId, id);
            next.push(...downstream(targetId).filter((child) => byId.get(child)?.type === "config"));
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
    successors.forEach((ids) => ids.forEach((id) => indegree.set(id, indegree.get(id) + 1)));
    const ready = [...steps.keys()].filter((id) => indegree.get(id) === 0);
    const result = [];
    for (let index = 0; index < ready.length; index++) {
        const id = ready[index];
        result.push(steps.get(id));
        for (const child of successors.get(id) || []) {
            indegree.set(child, indegree.get(child) - 1);
            if (indegree.get(child) === 0) ready.push(child);
        }
    }
    return result;
}


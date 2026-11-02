import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import type { GenerationDetails, NotificationOutcome } from "@/services/api/dingtalk";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

// Select display fields explicitly, never the provider configuration or credentials.
export function generationDetails(mode: "image" | "text" | "video" | "audio", config: AiConfig, target?: string): GenerationDetails {
    const kinds = { image: "图片", text: "文本", video: "视频", audio: "音频" };
    const quality = ({ auto: "自动", low: "低", medium: "中", high: "高" } as Record<string, string>)[config.quality] || config.quality;
    const parameters = mode === "image" ? `尺寸 ${config.size === "auto" ? "自动" : config.size} · 质量 ${quality} · 数量 ${config.count}`
        : mode === "video" ? `时长 ${config.videoSeconds} 秒 · 画质 ${config.vquality} · 模式 ${config.videoMode}`
        : mode === "audio" ? `音色 ${config.audioVoice} · 格式 ${config.audioFormat} · 语速 ${config.audioSpeed}`
        : `数量 ${config.count} · 推理强度 ${config.reasoningEffort}`;
    return { kind: kinds[mode], model: modelOptionName(config.model), output: target ? `替换指定图片：${target}` : "新增输出", parameters };
}

// Snapshot subscribers before generation: connecting a node mid-run never sends unexpectedly.
export function notificationTargets(sourceId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (nodes.find((node) => node.id === sourceId)?.type !== CanvasNodeType.Config) return [];
    return nodes.filter((node) => node.type === CanvasNodeType.DingTalk && connections.some((edge) => edge.fromNodeId === sourceId && edge.toNodeId === node.id));
}

export function notificationEnabled(node: CanvasNodeData, result: NotificationOutcome) {
    return result.status === "success" ? node.metadata?.notifySuccess !== false : result.status === "failure" ? node.metadata?.notifyFailure !== false : node.metadata?.notifyCanceled === true;
}

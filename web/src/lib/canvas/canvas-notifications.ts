import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import type { NotificationOutcome } from "@/services/api/dingtalk";

// Snapshot subscribers before generation: connecting a node mid-run never sends unexpectedly.
export function notificationTargets(sourceId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (nodes.find((node) => node.id === sourceId)?.type !== CanvasNodeType.Config) return [];
    return nodes.filter((node) => node.type === CanvasNodeType.DingTalk && connections.some((edge) => edge.fromNodeId === sourceId && edge.toNodeId === node.id));
}

export function notificationEnabled(node: CanvasNodeData, result: NotificationOutcome) {
    return result.status === "success" ? node.metadata?.notifySuccess !== false : result.status === "failure" ? node.metadata?.notifyFailure !== false : node.metadata?.notifyCanceled === true;
}

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { nanoid } from "nanoid";
import { dingTalkApi, type DingTalkDelivery, type DingTalkRequest, type NotificationOutcome } from "@/services/api/dingtalk";
import { notificationEnabled, notificationTargets } from "@/lib/canvas/canvas-notifications";
import type { CanvasNodeData, CanvasConnection } from "@/types/canvas";

type Delivery = { request: DingTalkRequest; message: string; state?: DingTalkDelivery["state"]; retryable?: boolean };
export function useGenerationNotifications(projectId: string, canvas: string, nodes: RefObject<CanvasNodeData[]>, connections: RefObject<CanvasConnection[]>) {
    const [deliveries, setDeliveries] = useState<Record<string, Delivery>>({});
    const scope = useRef({});
    useEffect(() => { scope.current = {}; setDeliveries({}); return () => { scope.current = {}; }; }, [projectId]);
    const send = useCallback(async (id: string, request: DingTalkRequest, check = false) => {
        const currentScope = scope.current;
        const update = (patch: Partial<Delivery>) => {
            if (scope.current === currentScope) setDeliveries((previous) => previous[id]?.request.eventId === request.eventId ? { ...previous, [id]: { ...previous[id], ...patch } } : previous);
        };
        if (!check) setDeliveries((previous) => ({ ...previous, [id]: { request, message: "正在提交工作通知…" } }));
        try { update(await dingTalkApi<DingTalkDelivery>(check ? "result" : "send", check ? { eventId: request.eventId } : request)); }
        catch (error) { update({ state: "unknown", message: error instanceof Error ? error.message : "通知结果未知，请查询发送结果" }); }
    }, []);
    const beginNotification = useCallback((sourceId: string) => {
        const targets = notificationTargets(sourceId, nodes.current, connections.current);
        const node = nodes.current.find((item) => item.id === sourceId)?.title || sourceId;
        const started = Date.now();
        const currentScope = scope.current;
        let finished = false;
        return (result: NotificationOutcome) => {
            if (finished || scope.current !== currentScope) return;
            finished = true;
            for (const target of targets) {
                if (!notificationEnabled(target, result)) continue;
                const channel = target.metadata?.notificationChannel || "";
                const users = target.metadata?.notificationUsers || [];
                const request = { ...result, eventId: nanoid(), channel, users, canvas, node, elapsedSeconds: Math.round((Date.now() - started) / 1000) };
                if (!channel || !users.length) {
                    setDeliveries((previous) => ({ ...previous, [target.id]: { request, state: "failed", message: "未发送：请先选择通知应用和接收员工" } }));
                } else void send(target.id, request);
            }
        };
    }, [canvas, connections, nodes, send]);
    return {
        beginNotification, deliveries,
        checkNotification: (id: string) => { if (deliveries[id]) void send(id, deliveries[id].request, true); },
        retryNotification: (id: string) => { if (deliveries[id]?.retryable) void send(id, { ...deliveries[id].request, eventId: nanoid() }); },
    };
}

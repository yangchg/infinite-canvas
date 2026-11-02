export type GenerationDetails = { kind: string; model: string; output: string; parameters: string; prompt?: string; references?: string };
export type NotificationOutcome = { status: "success" | "failure" | "canceled"; succeeded: number; failed: number };
export type DingTalkChannel = { id: string; name: string; users: { id: string; name: string }[] };
export type DingTalkRequest = NotificationOutcome & { eventId: string; channel: string; users: string[]; canvas: string; node: string; elapsedSeconds: number; details?: GenerationDetails };
export type DingTalkDelivery = { state: "submitted" | "delivered" | "failed" | "unknown"; message: string; retryable?: boolean };

export async function dingTalkApi<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/notifications/dingtalk/${path}`, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("钉钉通知服务未启动或未配置代理。");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "钉钉通知请求失败。");
    return result;
}

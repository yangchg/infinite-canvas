import { useEffect, useState } from "react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { dingTalkApi, type DingTalkChannel } from "@/services/api/dingtalk";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function CanvasDingTalkNodePanel({ node, sources, status, onChange, onCheck, onRetry }: {
    node: CanvasNodeData; sources: string[]; status?: string;
    onChange: (id: string, patch: Partial<CanvasNodeMetadata>) => void; onCheck?: () => void; onRetry?: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [channels, setChannels] = useState<DingTalkChannel[]>([]);
    const [error, setError] = useState("");
    useEffect(() => {
        let active = true;
        dingTalkApi<DingTalkChannel[]>("channels").then((value) => { if (active) { setChannels(value); setError(""); } }, (reason) => { if (active) setError(reason.message); });
        return () => { active = false; };
    }, []);
    const metadata = node.metadata || {};
    const channel = channels.find((item) => item.id === metadata.notificationChannel);
    return <div className="flex h-full flex-col gap-2 px-3 pb-3 pt-7 text-xs" style={{ color: theme.node.text }}>
        <strong>钉钉工作通知</strong>
        <div style={{ color: theme.node.muted }}>{sources.length ? `监听：${sources.join("、")}` : "从左侧连接点拖线到生成配置"}</div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto" onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
            <select aria-label="通知应用" value={metadata.notificationChannel || ""} style={{ background: theme.node.fill }} onChange={(event) => onChange(node.id, { notificationChannel: event.target.value, notificationUsers: [] })}>
                <option value="">选择通知应用</option>
                {metadata.notificationChannel && !channel && <option value={metadata.notificationChannel}>原应用不可用，请重新选择</option>}
                {channels.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <span>接收员工</span>
            {channel?.users.map((user) => <label key={user.id} className="flex gap-2"><input type="checkbox" checked={metadata.notificationUsers?.includes(user.id) || false} onChange={(event) => onChange(node.id, { notificationUsers: event.target.checked ? [...(metadata.notificationUsers || []), user.id] : metadata.notificationUsers?.filter((id) => id !== user.id) })} />{user.name}</label>)}
            <div className="flex gap-3">{([ ["notifySuccess", "成功"], ["notifyFailure", "失败"], ["notifyCanceled", "取消"] ] as const).map(([key, label]) => <label key={key} className="flex gap-1"><input type="checkbox" checked={key === "notifyCanceled" ? metadata[key] === true : metadata[key] !== false} onChange={(event) => onChange(node.id, { [key]: event.target.checked })} />{label}</label>)}</div>
            {error && <span>{error}</span>}
            <span>{status || "等待关联配置执行完成"}</span>
            {(onCheck || onRetry) && <div className="flex flex-wrap gap-3">{onCheck && <button type="button" onClick={onCheck}>查询发送结果</button>}{onRetry && <button type="button" onClick={onRetry}>仅重发通知</button>}</div>}
        </div>
    </div>;
}

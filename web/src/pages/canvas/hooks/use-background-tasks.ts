import { useCallback, useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import { workspaceApi, jsonBody } from "@/services/api/workspace";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { prepareBackgroundImage } from "@/services/api/image";

export type BackgroundStep = ReturnType<typeof prepareBackgroundImage> & { nodeId: string; targetId?: string };
export type BackgroundTask = {
    id: string; canvasId: string; entryId?: string; state: string; message?: string; createdAt: string; updatedAt: string;
    steps: { nodeId: string; targetId?: string; title: string; state: string; message?: string; canUndo: boolean; undone?: boolean; selectedImageId?: string;
        outputs: { id: string; content: string; storageKey: string }[];
        notifications?: { nodeId: string; state: string; message: string }[] }[];
};
export const taskActive = (task: BackgroundTask) => ["queued", "running", "canceling", "waiting_selection"].includes(task.state);
export const taskStatus = (state: string) => ({ queued: "排队中", running: "执行中", waiting_selection: "等待选图", canceling: "正在停止", canceled: "已停止", success: "已完成", failed: "失败", conflict: "需要处理", skipped: "未执行" }[state] || state);

export function useBackgroundTasks(projectId: string, enabled: boolean) {
    const [tasks, setTasks] = useState<BackgroundTask[]>([]);
    const [error, setError] = useState("");
    const scope = useRef({});
    const refreshing = useRef(false);
    const again = useRef(false);
    const refresh = useCallback(async () => {
        if (!enabled) return;
        if (refreshing.current) { again.current = true; return; }
        const currentScope = scope.current;
        refreshing.current = true;
        try {
            do {
                again.current = false;
                const result = await workspaceApi<BackgroundTask[]>(`/canvases/${projectId}/tasks`);
                if (scope.current !== currentScope) return;
                setTasks(result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
                await useCanvasStore.getState().syncProject(projectId);
            } while (again.current && scope.current === currentScope);
            if (scope.current === currentScope) setError("");
        } catch (failure) { if (scope.current === currentScope) setError(String(failure)); }
        finally { refreshing.current = false; }
    }, [enabled, projectId]);
    useEffect(() => {
        if (!enabled) return;
        scope.current = {};
        const events = new EventSource(`/api/canvases/${projectId}/task-events`);
        events.onmessage = () => { void refresh(); };
        events.onerror = () => setError("后台状态连接中断，任务仍在服务器执行；连接恢复后自动同步，也可点击刷新。");
        const focus = () => { void refresh(); };
        window.addEventListener("focus", focus);
        void refresh();
        return () => { scope.current = {}; events.close(); window.removeEventListener("focus", focus); };
    }, [enabled, projectId, refresh]);
    const submit = useCallback(async (steps: BackgroundStep[], entryId?: string) => {
        const store = useCanvasStore.getState();
        await store.flush();
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        try {
            const task = await workspaceApi<BackgroundTask>(`/canvases/${projectId}/tasks`, { method: "POST", body: jsonBody({ runId: nanoid(), revision: project?.revision, steps, entryId }) });
            setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)]);
        } finally { void refresh(); }
    }, [projectId, refresh]);
    const cancel = useCallback(async (taskId: string) => {
        await workspaceApi(`/tasks/${taskId}/cancel`, { method: "POST" });
        await refresh();
    }, [refresh]);
    const undo = useCallback(async (taskId: string, nodeId: string) => {
        await useCanvasStore.getState().flush();
        await workspaceApi(`/tasks/${taskId}/undo/${nodeId}`, { method: "POST" });
        await refresh();
    }, [refresh]);
    const confirmImage = useCallback(async (taskId: string, nodeId: string, imageId: string) => {
        await useCanvasStore.getState().flush();
        await workspaceApi(`/tasks/${taskId}/select/${nodeId}`, { method: "POST", body: jsonBody({ imageId }) });
        await refresh();
    }, [refresh]);
    const retry = useCallback(async (taskId: string, nodeId: string, targetId: string) => {
        await useCanvasStore.getState().flush();
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        await workspaceApi(`/tasks/${taskId}/retry/${nodeId}`, { method: "POST", body: jsonBody({ targetId, runId: nanoid(), revision: project?.revision }) });
        await refresh();
    }, [projectId, refresh]);
    return { tasks, error, refresh, submit, cancel, undo, confirmImage, retry };
}

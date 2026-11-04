import { create } from "zustand";
import { nanoid } from "nanoid";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { workspaceApi, jsonBody, setWorkspaceCsrf } from "@/services/api/workspace";
import { useSessionStore } from "@/stores/use-session-store";

import { canvasCategories, type CanvasCategory } from "@/lib/canvas/canvas-category";

export type CanvasProject = {
    category?: CanvasCategory;
    description?: string;
    id: string;
    number?: string;
    projectId?: string;
    ownerId?: string;
    ownerName?: string;
    revision?: number;
    publishedId?: string | null;
    deleted?: boolean;
    kind?: "canvas" | "usage";
    sourceId?: string | null;
    sourceVersion?: string | null;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
};
export type CanvasDeletedProject = { id: string; deletedAt: string };
export type WorkspaceProject = { id: string; title: string; archived: number; deleted: number };
type CanvasStore = {
    hydrated: boolean;
    projects: CanvasProject[];
    groups: WorkspaceProject[];
    selectedGroupId: string;
    deletedProjects: CanvasDeletedProject[];
    error: string;
    saving: boolean;
    dirty: boolean;
    load: () => Promise<void>;
    selectGroup: (id: string) => void;
    flush: () => Promise<void>;
    createProject: (title?: string, category?: CanvasCategory) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => void;
    deleteProjects: (ids: string[]) => Promise<void>;
    updateProject: (id: string, patch: Partial<CanvasProject>) => void;
    accept: (project: CanvasProject) => void;
};
const pending = new Map<string, CanvasProject>();
const revisions = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let draining: Promise<void> | undefined;
let editVersion = 0;

function schedule(project: CanvasProject) {
    editVersion += 1;
    pending.set(project.id, project);
    useCanvasStore.setState({ dirty: true });
    clearTimeout(timer);
    // Preserve the existing 400 ms autosave cadence.
    timer = setTimeout(() => { void useCanvasStore.getState().flush().catch(() => undefined); }, 400);
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
    hydrated: false, projects: [], groups: [], selectedGroupId: "", deletedProjects: [], error: "", saving: false, dirty: false,
    selectGroup: (id) => { sessionStorage.setItem("canvas-project", id); set({ selectedGroupId: id }); },
    load: async () => {
        try {
            await get().flush();
            const requestedVersion = editVersion;
            const [projects, groups] = await Promise.all([workspaceApi<CanvasProject[]>("/canvases"), workspaceApi<WorkspaceProject[]>("/projects")]);
            // An edit made during refresh remains authoritative in this tab.
            if (requestedVersion !== editVersion) { set({ groups, hydrated: true }); return; }
            projects.forEach((project) => revisions.set(project.id, project.revision || 0));
            const preferred = get().selectedGroupId || sessionStorage.getItem("canvas-project");
            const selectedGroupId = groups.find((item) => !item.deleted && item.id === preferred)?.id || groups.find((item) => !item.deleted)?.id || "";
            set({ projects, groups, selectedGroupId, hydrated: true, error: "" });
        } catch (error) { set({ error: String(error) }); }
    },
    flush: () => {
        clearTimeout(timer);
        if (draining) return draining;
        draining = (async () => {
            set({ saving: pending.size > 0 });
            try {
                if (pending.size) {
                    const session = await workspaceApi<{ user: { id: string }; csrf: string }>("/auth/me");
                    if (session.user.id !== useSessionStore.getState().user?.id) throw new Error("浏览器已切换账号，请使用原账号登录后重试；当前草稿仍保留");
                    setWorkspaceCsrf(session.csrf);
                }
                while (pending.size) {
                    const [id, project] = pending.entries().next().value!;
                    const response = await workspaceApi<{ revision: number; number: string }>(`/canvases/${id}`, { method: "PUT", body: jsonBody({ projectId: project.projectId, title: project.title, revision: revisions.get(id) || 0, content: project }) });
                    revisions.set(id, response.revision);
                    if (pending.get(id) === project) pending.delete(id);
                    set((state) => ({ projects: state.projects.map((item) => item.id === id ? { ...item, revision: response.revision, number: response.number } : item) }));
                }
                set({ error: "", dirty: false });
            } catch (error) { set({ error: String(error), dirty: true }); throw error; }
            finally { set({ saving: false }); }
        })().finally(() => { draining = undefined; });
        return draining;
    },
    createProject: (title = "未命名画布", category = "通用") => get().importProject({ title, category }),
    importProject: (source) => {
        const projectId = get().selectedGroupId;
        const group = get().groups.find((item) => item.id === projectId && !item.archived && !item.deleted);
        if (!group) throw new Error("请先选择一个可编辑项目；项目由管理员创建并分配成员");
        const now = new Date().toISOString();
        const project: CanvasProject = {
            id: nanoid(), projectId, ownerId: useSessionStore.getState().user?.id, ownerName: useSessionStore.getState().user?.displayName,
            category: canvasCategories.includes(source.category!) ? source.category : "通用",
            description: typeof source.description === "string" ? source.description : "",
            revision: 0, kind: "canvas", title: source.title || "未命名画布", createdAt: now, updatedAt: now,
            nodes: source.nodes || [], connections: source.connections || [], chatSessions: source.chatSessions || [], activeChatId: source.activeChatId || null,
            backgroundMode: source.backgroundMode || "lines", showImageInfo: source.showImageInfo || false, viewport: source.viewport || { x: 0, y: 0, k: 1 },
        };
        set((state) => ({ projects: [project, ...state.projects] }));
        schedule(project);
        return project.id;
    },
    openProject: (id) => {
        const project = get().projects.find((item) => item.id === id && !item.deleted) || null;
        if (project?.projectId) get().selectGroup(project.projectId);
        return project;
    },
    renameProject: (id, title) => { if (title.trim()) get().updateProject(id, { title: title.trim() }); },
    updateProject: (id, patch) => {
        const current = get().projects.find((item) => item.id === id && !item.deleted);
        if (!current || get().groups.find((item) => item.id === current.projectId)?.archived) return;
        const project = { ...current, ...patch, id: current.id, projectId: current.projectId, ownerId: current.ownerId, updatedAt: new Date().toISOString() };
        set((state) => ({ projects: state.projects.map((item) => item.id === id ? project : item) }));
        schedule(project);
    },
    deleteProjects: async (ids) => {
        await get().flush();
        for (const id of ids) await workspaceApi(`/canvases/${id}/lifecycle`, { method: "PATCH", body: jsonBody({ deleted: true }) });
        await get().load();
    },
    accept: (project) => {
        revisions.set(project.id, project.revision || 0);
        set((state) => ({ projects: [project, ...state.projects.filter((item) => item.id !== project.id)] }));
    },
}));

window.addEventListener("beforeunload", (event) => {
    if (useCanvasStore.getState().dirty) { event.preventDefault(); event.returnValue = ""; }
});

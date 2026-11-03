import { create } from "zustand";
import { workspaceApi, setWorkspaceCsrf, jsonBody, WorkspaceError } from "@/services/api/workspace";

export type SessionUser = { id: string; username: string; displayName: string; admin: boolean; disabled: boolean };
type Session = { user: SessionUser; csrf: string };
export const useSessionStore = create<{ user: SessionUser | null; ready: boolean; error: string; load: () => Promise<void>; authenticate: (register: boolean, values: { username: string; password: string; displayName?: string }) => Promise<void>; logout: () => Promise<void> }>((set) => ({
    user: null, ready: false, error: "",
    load: async () => {
        try {
            const session = await workspaceApi<Session>("/auth/me");
            setWorkspaceCsrf(session.csrf);
            if (sessionStorage.getItem("canvas-account") !== session.user.id) {
                sessionStorage.setItem("canvas-account", session.user.id);
                window.location.reload();
                return;
            }
            set({ user: session.user, ready: true, error: "" });
        } catch (error) {
            set({ user: null, ready: true, error: error instanceof WorkspaceError && error.status === 401 ? "" : String(error) });
        }
    },
    authenticate: async (register, values) => {
        const session = await workspaceApi<Session>(register ? "/auth/register" : "/auth/login", { method: "POST", body: jsonBody(values) });
        sessionStorage.setItem("canvas-account", session.user.id);
        window.location.assign("/canvas");
    },
    logout: async () => {
        const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
        await useCanvasStore.getState().flush();
        await workspaceApi("/auth/logout", { method: "POST" });
        sessionStorage.removeItem("canvas-account");
        window.location.assign("/login");
    },
}));

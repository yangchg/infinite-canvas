export class WorkspaceError extends Error {
    public status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
}
let csrf = "";
export function setWorkspaceCsrf(value: string) { csrf = value; }
export async function workspaceApi<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    headers.set("X-CSRF-Token", csrf);
    headers.set("X-Account-Id", sessionStorage.getItem("canvas-account") || "");
    const response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", headers });
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new WorkspaceError(body.message || `请求失败 (${response.status})`, response.status);
    }
    return response.json();
}
export const jsonBody = (value: unknown) => JSON.stringify(value);
export async function uploadServerFile(key: string, blob: Blob) {
    await workspaceApi(`/files/${encodeURIComponent(key)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-File-Type": blob.type || "application/octet-stream" }, body: blob });
}
export async function readServerFile(key: string) {
    const response = await fetch(`/api/files/${encodeURIComponent(key)}`, { credentials: "same-origin" });
    if (!response.ok) throw new WorkspaceError("附件不存在或无权访问", response.status);
    const blob = await response.blob();
    return blob.slice(0, blob.size, response.headers.get("X-File-Type") || "application/octet-stream");
}

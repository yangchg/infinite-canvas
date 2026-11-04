import axios from "axios";
import { workspaceApi, jsonBody } from "./workspace";

const runs = new WeakMap<AbortSignal, { canvasId: string; runId: string; sent: boolean; onError: () => void }>();
export function trackCanvasRun(signal: AbortSignal, canvasId: string, onError: () => void) {
    if (!runs.has(signal)) runs.set(signal, { canvasId, runId: crypto.randomUUID(), sent: false, onError });
}
export function markCanvasSubmission(signal?: AbortSignal) {
    if (!signal || signal.aborted) return;
    const run = runs.get(signal);
    if (!run || run.sent) return;
    run.sent = true;
    void workspaceApi(`/canvases/${run.canvasId}/usage-runs`, { method: "POST", body: jsonBody({ runId: run.runId }) }).catch(run.onError);
}
// Only explicitly tracked configuration runs are counted, immediately before transport dispatch.
axios.interceptors.request.use((request) => {
    if (request.method?.toLowerCase() === "post") markCanvasSubmission(request.signal as AbortSignal | undefined);
    return request;
});

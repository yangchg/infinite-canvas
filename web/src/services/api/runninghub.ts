import { jsonBody, workspaceApi } from "./workspace";

export type RunningHubChoice = { nodeId: string; field?: string; label: string; defaultValue?: string };
export type RunningHubInput = { id: string; nodeId: string; field: string; label: string; type: "text" | "image"; required: boolean; defaultValue?: string };
export type RunningHubMapping = { inputs: RunningHubInput[]; outputNodes: string[] };
export type RunningHubWorkflow = { workflowId: string; name?: string; prompts: RunningHubChoice[]; advancedTexts: RunningHubChoice[]; images: RunningHubChoice[]; outputs: RunningHubChoice[] };
export type RunningHubSettings = { hasKey: boolean; needsSetup?: boolean };
export const getRunningHubSettings = () => workspaceApi<RunningHubSettings>("/admin/runninghub/settings");
export const saveRunningHubSettings = (apiKey: string) => workspaceApi<RunningHubSettings>("/admin/runninghub/settings", { method: "PUT", body: jsonBody({ apiKey }) });
export const readRunningHubWorkflow = (source: string, workflow?: unknown) => workspaceApi<RunningHubWorkflow>("/admin/runninghub/workflow", { method: "POST", body: jsonBody({ source, workflow }) });

import { create } from "zustand";
import { workspaceApi } from "@/services/api/workspace";
import type { AiConfig, ModelCapability, ApiCallFormat } from "./use-config-store";

export type ServerModel = { id: string; name: string; model: string; capability: ModelCapability; apiFormat: ApiCallFormat | "comfyui" | "runninghub"; runninghub?: import("@/services/api/runninghub").RunningHubMapping };
let pending: Promise<void> | undefined;
export const useServerModelStore = create<{ models: ServerModel[]; loading: boolean; error: string; load: () => Promise<void> }>((set) => ({
    models: [], loading: false, error: "",
    load: () => {
        if (pending) return pending;
        set({ loading: true, error: "" });
        pending = workspaceApi<ServerModel[]>("/models").then((models) => { set({ models }); }).catch((error) => { set({ models: [], error: String(error) }); }).finally(() => { pending = undefined; set({ loading: false }); });
        return pending;
    },
}));

export function configForModelSource(config: AiConfig, source?: "local" | "server", model?: string): AiConfig {
    if (source !== "server" && !model?.startsWith("server-")) return config;
    const channels = useServerModelStore.getState().models.map((item) => ({
        id: `server-${item.id}`, name: item.name, baseUrl: `/api/model-gateway/${item.id}`, apiKey: "server-managed",
        apiFormat: item.apiFormat === "comfyui" || item.apiFormat === "runninghub" ? "openai" as const : item.apiFormat, models: [{ name: item.model, capability: item.capability }],
    }));
    return { ...config, modelSource: "server", channelMode: "remote", channels, models: channels.map((channel) => `${channel.id}::${channel.models[0].name}`), model: "", imageModel: "", textModel: "", videoModel: "", audioModel: "" };
}

export function validateServerImageInputs(config: AiConfig, imageCount: number) {
    const selected = config.model || config.imageModel;
    const model = useServerModelStore.getState().models.find((item) => selected === `server-${item.id}::${item.model}`);
    if (model?.apiFormat === "comfyui" && imageCount > 0) throw new Error("当前 ComfyUI 工作流仅支持文生图，请移除参考图或选择支持图生图的模型。");
}

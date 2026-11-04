import { create } from "zustand";
import { workspaceApi } from "@/services/api/workspace";
import type { AiConfig, ModelCapability, ApiCallFormat } from "./use-config-store";

export type ServerModel = { id: string; name: string; model: string; capability: ModelCapability; apiFormat: ApiCallFormat | "comfyui" | "runninghub" };
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
    if (model?.apiFormat === "runninghub" && imageCount !== 1) {
        throw new Error("当前 RunningHub 模型需要且仅支持 1 张参考图。切换模型会保留原提示词；请连接图片，使用「组装提示词」时还需输入 @ 并选中图片。修改配置后请点击「开始生成」，旧结果的「重试」沿用原参数。");
    }
    if (model?.apiFormat === "comfyui" && imageCount > 0) throw new Error("当前 ComfyUI 工作流仅支持文生图，请移除参考图或选择支持图生图的模型。");
}

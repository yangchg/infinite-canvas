import { afterAll, expect, test } from "bun:test";
import type { AiConfig, ModelCapability } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";

// Config and i18n use browser storage during module initialization.
const values = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => "test-account" } });
Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    },
});
afterAll(() => {
    if (originalSession) Object.defineProperty(globalThis, "sessionStorage", originalSession);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { defaultConfig, resolveModelForCapability, useConfigStore } = await import("../src/stores/use-config-store");
const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");
const { useServerModelStore, configForModelSource, validateServerImageInputs } = await import("../src/stores/use-server-model-store");
const { resolveModelRequestConfig } = await import("../src/stores/use-config-store");

test("switching image models validates current reference requirements without stale model state", () => {
    useServerModelStore.setState({ models: [
        { id: "rh", name: "RH", model: "123", capability: "image", apiFormat: "runninghub" },
        { id: "comfy", name: "Comfy", model: "test", capability: "image", apiFormat: "comfyui" },
    ] });
    const selected = { ...defaultConfig, modelSource: "server" as const, model: "server-comfy::test" };
    expect(() => validateServerImageInputs(selected, 0)).not.toThrow();
    selected.model = "server-rh::123";
    expect(() => validateServerImageInputs(selected, 0)).toThrow("输入 @");
    expect(() => validateServerImageInputs(selected, 1)).not.toThrow();
    expect(() => validateServerImageInputs(selected, 2)).toThrow("仅支持 1 张");
    selected.model = "server-comfy::test";
    expect(() => validateServerImageInputs(selected, 1)).toThrow("仅支持文生图");
    expect(() => validateServerImageInputs(selected, 0)).not.toThrow();
});

const config: AiConfig = {
    ...defaultConfig,
    videoModel: "replacement::video-b",
    channels: [
        {
            id: "replacement",
            name: "Replacement",
            baseUrl: "https://example.com",
            apiKey: "test-key",
            apiFormat: "openai",
            models: [
                { name: "video-b", capability: "video" },
                { name: "video-a", capability: "video" },
                { name: "image-a", capability: "image" },
            ],
        },
    ],
};
const ready = useConfigStore.getState().isAiConfigReady;
const videoNode = (model: string): CanvasNodeData => ({
    id: "saved-video",
    type: CanvasNodeType.Video,
    title: "Saved video",
    position: { x: 0, y: 0 },
    width: 320,
    height: 180,
    metadata: { model, videoTaskId: "original-task", videoTaskProvider: "openai", seconds: "4" },
});

test("a saved video on a removed provider is not replaced by the default video model", () => {
    const selected = buildGenerationConfig(config, videoNode("removed::video-a"), "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("removing a model from an existing provider prevents retry even with valid credentials", () => {
    const selected = buildGenerationConfig(config, videoNode("replacement::deleted-video"), "video");
    expect(selected.model).toBe("replacement::deleted-video");
    expect(ready(selected, selected.model)).toBe(false);
});

test("task recovery rejects a missing provider instead of querying the first provider", () => {
    expect(ready(config, "removed::video-a")).toBe(false);
    expect(ready(config, "unknown-video")).toBe(false);
});

test("an explicitly selected unavailable default is not replaced by the built-in default", () => {
    const selected = buildGenerationConfig({ ...config, videoModel: "removed::video-a" }, undefined, "video");
    expect(selected.model).toBe("removed::video-a");
    expect(ready(selected, selected.model)).toBe(false);
});

test("a new node without a selection still uses its configured default", () => {
    const selected = buildGenerationConfig(config, undefined, "video");
    expect(selected.model).toBe("replacement::video-b");
    expect(ready(selected, selected.model)).toBe(true);
});

test("switching generation capability still selects a model of the new capability", () => {
    expect(resolveModelForCapability(config, "replacement::image-a", "video")).toBe("replacement::video-b");
});

test("changing only the key on the same provider preserves the saved model and task", () => {
    const node = videoNode("replacement::video-a");
    const selected = buildGenerationConfig({ ...config, channels: [{ ...config.channels[0], apiKey: "rotated-key" }] }, node, "video");
    expect(selected.model).toBe("replacement::video-a");
    expect(ready(selected, selected.model)).toBe(true);
    expect(node.metadata?.videoTaskId).toBe("original-task");
    expect(ready({ ...selected, channels: [{ ...config.channels[0], apiKey: "" }] }, selected.model)).toBe(false);
});

test("unavailable explicit selections are preserved for every generation capability", () => {
    for (const capability of ["image", "video", "text", "audio"] as ModelCapability[]) {
        expect(resolveModelForCapability(config, `removed::${capability}`, capability)).toBe(`removed::${capability}`);
    }
});

test("server selection uses the catalog without local credentials and local selection stays unchanged", () => {
    useServerModelStore.setState({ models: [{ id: "team", name: "Team", model: "image-a", capability: "image", apiFormat: "openai" }] });
    const node = { ...videoNode("server-team::image-a"), metadata: { modelSource: "server" as const, model: "server-team::image-a" } };
    const selected = buildGenerationConfig(config, node, "image");
    expect(ready(selected, selected.model)).toBe(true);
    const request = resolveModelRequestConfig(selected, selected.model);
    expect(request.baseUrl).toBe("/api/model-gateway/team");
    expect(request.apiKey).not.toBe("test-key");
    expect(request.model).toBe("image-a");
    expect(configForModelSource(config, "local")).toBe(config);
    expect(config.channels[0].apiKey).toBe("test-key");
});

test("server mode requires explicit selection and never falls back after removal", () => {
    useServerModelStore.setState({ models: [] });
    const empty = buildGenerationConfig(config, { ...videoNode(""), metadata: { modelSource: "server" } }, "image");
    expect(empty.model).toBe("");
    expect(ready(empty, empty.model)).toBe(false);
    const removed = buildGenerationConfig(config, videoNode("server-removed::video-a"), "video");
    expect(removed.model).toBe("server-removed::video-a");
    expect(ready(removed, removed.model)).toBe(false);
    expect(() => resolveModelRequestConfig(removed, removed.model)).toThrow("服务器模型不可用");
});

test("RunningHub uses the server gateway and forces single-image generation", () => {
    useServerModelStore.setState({ models: [{ id: "rh", name: "RH", model: "123", capability: "image", apiFormat: "runninghub" }] });
    const selected = buildGenerationConfig(config, { ...videoNode("server-rh::123"), metadata: { modelSource: "server", model: "server-rh::123", count: 4 } }, "image");
    const request = resolveModelRequestConfig(selected, selected.model);
    expect(request.baseUrl).toBe("/api/model-gateway/rh");
    expect(request.apiFormat).toBe("openai");
    expect(selected.count).toBe("1");
});

test("ComfyUI uses the authenticated server gateway with the existing image client", () => {
    useServerModelStore.setState({ models: [{ id: "comfy", name: "ComfyUI", model: "test", capability: "image", apiFormat: "comfyui" }] });
    const selected = buildGenerationConfig(config, { ...videoNode("server-comfy::test"), metadata: { modelSource: "server", model: "server-comfy::test" } }, "image");
    const request = resolveModelRequestConfig(selected, selected.model);
    expect(request.baseUrl).toBe("/api/model-gateway/comfy");
    expect(request.apiFormat).toBe("openai");
    expect(request.model).toBe("test");
    expect(config.channels[0].apiKey).toBe("test-key");
});

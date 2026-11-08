import { useEffect, type CSSProperties } from "react";
import { configForModelSource, useServerModelStore } from "@/stores/use-server-model-store";
import { Image as ImageIcon, LoaderCircle, MessageSquare, Music2, Play, Settings2, Square, Video } from "lucide-react";
import { Button, Segmented } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type CanvasConfigNodePanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string) => void;
    outputImages: CanvasNodeData[];
    onReplaceOutput: (nodeId: string, targetId: string) => void;
    onStop: (nodeId: string) => void;
    onComposerToggle: () => void;
    onReviewImages?: () => void;
};

export function CanvasConfigNodePanel({ node, isRunning, inputSummary, onConfigChange, onGenerate, outputImages, onReplaceOutput, onStop, onComposerToggle, onReviewImages }: CanvasConfigNodePanelProps) {
    const replacementId = node.metadata?.replacementOutputId || "";
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const serverModels = useServerModelStore();
    const source = node.metadata?.modelSource || (node.metadata?.model?.startsWith("server-") ? "server" : "local");
    useEffect(() => { if (source === "server") void serverModels.load(); }, [source]);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = node.metadata?.generationMode || "image";
    const config = buildNodeConfig(configForModelSource(globalConfig, source, node.metadata?.model), node, mode);
    const isRunningHubModel = (model: string) => source === "server" && serverModels.models.some((item) => item.apiFormat === "runninghub" && model === `server-${item.id}::${item.model}`);
    const isRunningHub = isRunningHubModel(config.model);
    const chipStyle = { background: theme.node.fill, borderColor: theme.node.stroke, color: theme.node.text };
    const hasAnyInput = Boolean(inputSummary.textCount || inputSummary.imageCount || inputSummary.videoCount || inputSummary.audioCount);
    const hasComposerContent = Boolean((node.metadata?.composerContent ?? node.metadata?.prompt ?? "").trim());
    const canGenerate = hasComposerContent || (mode === "audio" ? inputSummary.textCount > 0 : hasAnyInput);
    const selectedOutputId = mode === "image" ? replacementId : "";
    const emptyOutputId = outputImages.find((image) => !image.metadata?.content && !image.metadata?.storageKey)?.id;
    useEffect(() => {
        if (mode === "image" && node.metadata?.replacementOutputId === undefined && emptyOutputId && !isRunning) {
            onConfigChange(node.id, { replacementOutputId: emptyOutputId });
        }
    }, [mode, node.id, node.metadata?.replacementOutputId, emptyOutputId, isRunning, onConfigChange]);
    const fillingOutput = outputImages.some((image) => image.id === selectedOutputId && !image.metadata?.content && !image.metadata?.storageKey);
    const missingOutput = Boolean(selectedOutputId && !outputImages.some((image) => image.id === selectedOutputId));

    return (
        <div className="flex h-full w-full cursor-move flex-col overflow-y-auto px-3 pb-3 pt-7 text-sm" style={{ color: theme.node.text }} onWheel={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="shrink-0 text-sm font-semibold">{t("canvas.configNode.title")}</div>
                <div className="cursor-default" onMouseDown={(event) => event.stopPropagation()}>
                    <Segmented
                        size="small"
                        className="canvas-config-mode !rounded-md !p-0.5"
                        value={mode}
                        onChange={(value) => onConfigChange(node.id, { generationMode: value as CanvasGenerationMode })}
                        options={[
                            {
                                value: "image",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <ImageIcon className="size-3.5" />
                                        {t("canvas.configNode.image")}
                                    </span>
                                ),
                            },
                            {
                                value: "text",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <MessageSquare className="size-3.5" />
                                        {t("canvas.configNode.text")}
                                    </span>
                                ),
                            },
                            {
                                value: "video",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Video className="size-3.5" />
                                        {t("canvas.configNode.video")}
                                    </span>
                                ),
                            },
                            {
                                value: "audio",
                                label: (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="size-3.5" />
                                        {t("canvas.configNode.audio")}
                                    </span>
                                ),
                            },
                        ]}
                    />
                </div>
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
                <InputChip label={t("canvas.configNode.prompt")} value={t("canvas.configNode.items", { count: inputSummary.textCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.references")} value={t("canvas.configNode.images", { count: inputSummary.imageCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.videoReferences")} value={t("canvas.configNode.items", { count: inputSummary.videoCount })} style={chipStyle} />
                <InputChip label={t("canvas.configNode.audioReferences")} value={t("canvas.configNode.items", { count: inputSummary.audioCount })} style={chipStyle} />
                <button type="button" className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 text-[11px]" style={chipStyle} onMouseDown={(event) => event.stopPropagation()} onClick={onComposerToggle}>
                    <Settings2 className="size-3.5" />
                    {t("canvas.configNode.compose")}
                </button>
            </div>

            <div className="mb-2 flex cursor-default items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <Segmented size="small" disabled={isRunning} value={source} options={[{ label: "本地模型", value: "local" }, { label: "服务器模型", value: "server" }]} onChange={(value) => onConfigChange(node.id, { modelSource: value as "local" | "server", model: "" })} />
                {source === "server" && <button type="button" disabled={serverModels.loading} onClick={() => void serverModels.load()}>{serverModels.loading ? "加载中…" : "刷新清单"}</button>}
            </div>
            {source === "server" && <div className="mb-2 text-xs" style={{ color: theme.node.muted }}>{serverModels.error || (!config.models.length && !serverModels.loading ? "暂无服务器模型，请联系管理员配置" : "")}</div>}
            <div className="mb-2 grid min-w-0 cursor-default grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                <ModelPicker className="canvas-compact-control h-10" config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model, ...(isRunningHubModel(model) ? { count: 1 } : {}) })} capability={mode} onMissingConfig={() => openConfigDialog(true)} fullWidth />
                {mode === "video" ? (
                    <CanvasVideoSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-auto !min-h-10 !w-full !justify-start !rounded-lg !px-2 !py-2 !text-left [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:break-words [&_.truncate]:min-w-0" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                ) : mode === "image" && isRunningHub ? (
                    <span className="text-xs">工作流尺寸 · 1 张</span>
                ) : mode === "image" ? (
                    <CanvasImageSettingsPopover config={config} placement="topRight" autoAdjustOverflow={false} buttonClassName="canvas-compact-control !h-auto !min-h-10 !w-full !justify-start !rounded-lg !px-2 !py-2 !text-left [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:break-words [&_.truncate]:min-w-0" onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })} />
                ) : mode === "audio" ? (
                    <CanvasAudioSettingsPopover config={config} placement="topRight" buttonClassName="canvas-compact-control !h-auto !min-h-10 !w-full !justify-start !rounded-lg !px-2 !py-2 !text-left [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:break-words [&_.truncate]:min-w-0" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                ) : (
                    <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} placement="topRight" buttonClassName="canvas-compact-control !h-auto !min-h-10 !w-full !justify-start !rounded-lg !px-2 !py-2 !text-left [&_.truncate]:whitespace-normal [&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:break-words [&_.truncate]:min-w-0" onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                )}
            </div>

            {isRunningHub && <div className="mb-2 text-xs" style={{ color: theme.node.muted }}>需要 1 张参考图。切换模型保留原提示词；若使用「组装提示词」，须输入 @ 并选中已连接的图片。修改后点击「开始生成」，旧结果的「重试」沿用原参数。图片将上传 RunningHub，使用服务器账号计费。</div>}
            {mode === "image" && source === "server" && <div className="mb-2 text-xs" onMouseDown={(event) => event.stopPropagation()}>
                <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={Boolean(node.metadata?.confirmImageSelection)} disabled={isRunning} onChange={(event) => onConfigChange(node.id, { confirmImageSelection: event.target.checked })} />
                    人工选图后继续
                </label>
                {node.metadata?.confirmImageSelection && <p className="mt-1" style={{ color: theme.node.muted }}>流水线生成多张后等待确认；需选择固定输出图片节点。单张结果自动继续。</p>}
            </div>}
            {onReviewImages && <button type="button" className="mb-2 rounded px-2 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10" onMouseDown={(event) => event.stopPropagation()} onClick={onReviewImages}>等待选图 · 选择图片并继续</button>}
            <div className="mt-auto flex min-w-0 items-center gap-2" onMouseDown={(event) => event.stopPropagation()}>
                {mode === "image" && (outputImages.length > 0 || replacementId) && (
                    <select
                        aria-label="输出方式：新增输出或替换指定输出图片"
                        className="h-9 min-w-0 flex-1 cursor-pointer rounded px-1 py-1 text-xs"
                        style={{ background: theme.node.fill, color: theme.node.text }}
                        value={selectedOutputId}
                        disabled={isRunning}
                        onChange={(event) => onConfigChange(node.id, { replacementOutputId: event.target.value })}
                    >
                        <option value="">新增输出</option>
                        {missingOutput && <option value={selectedOutputId} disabled>替换目标已断开，请重新选择</option>}
                        {outputImages.map((image, index) => <option key={image.id} value={image.id}>{image.metadata?.content || image.metadata?.storageKey ? "替换" : "填入"} {index + 1}. {image.title || "图片"} · {image.id.slice(-6)}</option>)}
                    </select>
                )}
                <Button
                    type="primary"
                    className="!h-9 flex-1 !cursor-pointer !rounded-lg"
                    danger={isRunning}
                    disabled={!isRunning && (!canGenerate || missingOutput || (source === "server" && (serverModels.loading || !config.models.includes(config.model))))}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => (isRunning ? onStop(node.id) : selectedOutputId ? onReplaceOutput(node.id, selectedOutputId) : onGenerate(node.id))}
                >
                    <span className="inline-flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span>{t("canvas.configNode.stop")}</span>
                            </>
                        ) : (
                            <>
                                <Play className="size-4" />
                                <span>{selectedOutputId ? fillingOutput ? "生成到此节点" : "生成并替换" : t("canvas.configNode.generate")}</span>
                            </>
                        )}
                    </span>
                </Button>
            </div>
        </div>
    );
}

function InputChip({ label, value, style }: { label: string; value: string; style: CSSProperties }) {
    return (
        <div className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px]" style={style}>
            <span>{label}</span>
            <span className="font-medium">{value}</span>
        </div>
    );
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasGenerationMode): AiConfig {
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || globalConfig.size || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node.metadata?.videoMode || globalConfig.videoMode || defaultConfig.videoMode,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || (mode === "image" ? globalConfig.canvasImageCount || globalConfig.count : globalConfig.count) || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}

import { useEffect, useId, useMemo, useState } from "react";
import { Cpu } from "lucide-react";
import { Select as SearchSelect } from "antd";
import { useServerModelStore } from "@/stores/use-server-model-store";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { modelOptionLabel, modelOptionName, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const [tags, setTags] = useState<string[]>([]);
    const [untagged, setUntagged] = useState(false);
    const serverModels = useServerModelStore(state => state.models);
    const options = useMemo(() => Array.from(new Set([...(config.channelMode === "local" && !capability ? [value] : []), ...selectableModelsByCapability(config, capability)].filter((model): model is string => Boolean(model)))), [capability, config, value]);
    const current = value || "";
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    const runningHubModels = serverModels.filter(item => item.apiFormat === "runninghub" && options.includes(`server-${item.id}::${item.model}`));
    if (runningHubModels.length) {
        const availableTags = [...new Set(runningHubModels.flatMap(item => item.tags || []))].sort();
        const displayLabel = (model: string) => {
            const item = runningHubModels.find(item => model === `server-${item.id}::${item.model}`);
            return item ? `${item.name}（${item.model}）` : modelOptionLabel(config, model);
        };
        return <SearchSelect
            aria-label="选择模型" showSearch optionFilterProp="searchText" allowClear={false}
            className={cn("min-w-0", fullWidth ? "w-full" : "w-72", className)}
            value={current || undefined} placeholder={pickerPlaceholder} open={open}
            onOpenChange={next => { if (next) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId })); setOpen(next); }}
            onChange={onChange} labelRender={() => current ? displayLabel(current) : pickerPlaceholder}
            onMouseDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
            options={options.flatMap(model => {
                const item = runningHubModels.find(item => model === `server-${item.id}::${item.model}`);
                if ((tags.length || untagged) && (!item || !((untagged && !item.tags?.length) || tags.some(tag => item.tags?.includes(tag))))) return [];
                const label = displayLabel(model);
                return [{ value: model, label: <span>{label}{Boolean(item?.tags?.length) && <span className="ml-2 text-xs opacity-60">{item!.tags!.join(" · ")}</span>}</span>, searchText: `${label} ${item?.tags?.join(" ") || ""}` }];
            })}
            popupRender={menu => <div data-canvas-no-zoom onWheel={event => event.stopPropagation()}>
                <div className="flex flex-wrap gap-1 p-2" onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}>
                    <button type="button" className="px-1 text-xs underline" onClick={() => { setTags([]); setUntagged(false); }}>全部模型</button>
                    {availableTags.map(tag => <button type="button" key={tag} aria-pressed={tags.includes(tag)} className={cn("px-1 text-xs", tags.includes(tag) && "font-bold underline")} onClick={() => setTags(previous => previous.includes(tag) ? previous.filter(value => value !== tag) : [...previous, tag])}>{tag}</button>)}
                    <button type="button" aria-pressed={untagged} className={cn("px-1 text-xs", untagged && "font-bold underline")} onClick={() => setUntagged(value => !value)}>未标记</button>
                </div>{menu}
            </div>}
        />;
    }

    return (
        <Select
            open={open}
            value={current}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length && config.channelMode === "local") onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={onChange}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={current ? modelOptionLabel(config, current) : pickerPlaceholder}
            >
                <ModelIcon model={current} />
                <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{current ? modelOptionLabel(config, current) : pickerPlaceholder}</span>
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((model) => (
                        <SelectItem key={model} value={model} textValue={modelOptionLabel(config, model)}>
                            <ModelLabel config={config} model={model} />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {emptyModelLabel(config, capability)}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelLabel({ config, model }: { config: AiConfig; model: string }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            <span className="truncate">{modelOptionLabel(config, model)}</span>
        </span>
    );
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(modelOptionName(model));
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}

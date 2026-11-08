import { useState } from "react";
import type { BackgroundTask } from "../hooks/use-background-tasks";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function BackgroundImageSelection({ outputs, onConfirm }: {
    outputs: BackgroundTask["steps"][number]["outputs"];
    onConfirm: (imageId: string) => Promise<void>;
}) {
    const [selected, setSelected] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const image = outputs.find((item) => item.id === selected);
    return <div className="my-3">
        <p className="mb-2">选择一张图片，确认后沿原连线继续，无需重新连接。</p>
        <div className="grid grid-cols-2 gap-2">
            {outputs.map((item, index) => <button key={item.id} type="button" aria-pressed={selected === item.id} disabled={submitting}
                className="overflow-hidden rounded border-2 p-1 hover:bg-black/5 dark:hover:bg-white/10"
                style={{ borderColor: selected === item.id ? theme.node.text : theme.node.stroke }} onClick={() => setSelected(item.id)}>
                <img src={item.content} alt={`候选图片 ${index + 1}`} className="h-28 w-full object-contain" />
                <span>{selected === item.id ? "已选择" : "选择"} {index + 1}</span>
            </button>)}
        </div>
        {image && <a href={image.content} target="_blank" rel="noreferrer" className="mt-2 inline-block underline">查看所选原图</a>}
        <button type="button" disabled={!image || submitting} className="mt-2 block w-full rounded px-3 py-2 font-medium hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
            onClick={async () => {
                if (!image || submitting) return;
                setSubmitting(true); setError("");
                try { await onConfirm(image.id); }
                catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
                finally { setSubmitting(false); }
            }}>{submitting ? "正在确认…" : "确认此图并继续"}</button>
        {error && <p role="alert" className="mt-2">{error}</p>}
    </div>;
}

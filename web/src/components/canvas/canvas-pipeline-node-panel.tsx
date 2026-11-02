import { Play, Square } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasPipelineNodePanel({ running, disabled, status, onRun, onStop }: {
    running: boolean;
    disabled: boolean;
    status: string;
    onRun: () => void;
    onStop: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="flex h-full flex-col gap-2 px-3 pb-3 pt-7" style={{ color: theme.node.text }}>
            <div className="text-sm font-semibold">流水线</div>
            <div className="min-h-0 flex-1 overflow-auto text-xs" style={{ color: theme.node.muted }} title={status}>{status || "连接生成配置，按流程依次执行"}</div>
            <button type="button" className="flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded py-1 text-sm hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                disabled={disabled && !running} onMouseDown={(event) => event.stopPropagation()} onClick={running ? onStop : onRun}>
                {running ? <Square className="size-4" /> : <Play className="size-4" />}
                {running ? "停止流水线" : "运行流水线"}
            </button>
        </div>
    );
}

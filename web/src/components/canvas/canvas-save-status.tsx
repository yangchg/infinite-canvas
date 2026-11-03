import { useParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";

export function CanvasSaveStatus() {
    const { id } = useParams();
    const { error, saving, dirty, flush, projects } = useCanvasStore();
    const { message } = App.useApp();
    const project = projects.find((item) => item.id === id);
    return <div className="flex max-w-sm items-center gap-1 text-xs" data-canvas-no-zoom>
        <span className="select-text whitespace-nowrap font-mono">{project?.number || "编号待保存后分配"}</span>
        {project?.kind === "usage" && <span>个人使用记录 · 不修改原画布</span>}
        <Tooltip title={error || "画布保存到部署服务器"}><span role="status">{error ? "保存失败" : saving ? "保存中…" : dirty ? "等待保存" : "已保存"}</span></Tooltip>
        {error && <><Button type="text" size="small" onClick={() => void flush().catch((error) => message.error(String(error)))}>重试</Button><Button type="text" size="small" onClick={() => project && void exportCanvasProjects([project], `${project.title}-未保存草稿`).catch((error) => message.error(String(error)))}>导出草稿</Button><a href="/login" target="_blank" rel="noopener noreferrer">重新登录</a></>}
    </div>;
}

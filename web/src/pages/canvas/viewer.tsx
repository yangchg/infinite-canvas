import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Alert, App, Button, Space, Spin } from "antd";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { workspaceApi, jsonBody } from "@/services/api/workspace";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";

export default function CanvasViewer({ published = true }: { published?: boolean }) {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const containerRef = useRef<HTMLDivElement>(null);
    const [project, setProject] = useState<CanvasProject>();
    const [error, setError] = useState("");
    const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const groups = useCanvasStore((state) => state.groups);
    useEffect(() => {
        let current = true;
        void (async () => {
            try {
                const source = published ? await workspaceApi<CanvasProject>(`/canvases/${id}/public`) : useCanvasStore.getState().projects.find((item) => item.id === id);
                if (!source) throw new Error("画布不存在");
                const nodes = await hydrateCanvasImages(source.nodes);
                if (current) { setProject({ ...source, nodes }); setViewport(source.viewport); }
            } catch (error) { if (current) setError(String(error)); }
        })();
        return () => { current = false; };
    }, [id, published]);
    const useCanvas = async () => {
        try {
            const item = await workspaceApi<CanvasProject>(`/canvases/${id}/use`, { method: "POST", body: jsonBody({ kind: "usage" }) });
            useCanvasStore.getState().accept(item); navigate(`/canvas/${item.id}`);
        } catch (error) { message.error(String(error)); }
    };
    if (error) return <Alert title="无法打开画布" description={error} type="error" action={<Button onClick={() => navigate("/canvas")}>返回</Button>} />;
    if (!project) return <Spin fullscreen />;
    return <div className="relative h-full" style={{ color: theme.node.text }}>
        <div className="absolute inset-x-0 top-0 z-50 flex flex-wrap items-center justify-between gap-3 p-4" style={{ background: theme.canvas.background }}>
            <span>{project.title} · 编号：{project.number} · 所有者：{project.ownerName} · {published ? "公共版本（只读）" : "项目已归档（只读）"}</span>
            <Space><Button onClick={() => navigate("/canvas")}>返回</Button>{published && <Button disabled={Boolean(groups.find((item) => item.id === project.projectId)?.archived)} onClick={() => void useCanvas()}>使用此版本</Button>}<Button onClick={() => void exportCanvasProjects([project], project.title).catch((error) => message.error(String(error)))}>导出</Button></Space>
        </div>
        <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" backgroundMode={project.backgroundMode} onViewportChange={setViewport}>
            <svg className="pointer-events-none absolute overflow-visible" width="1" height="1">
                {project.connections.map((edge) => { const from = project.nodes.find((node) => node.id === edge.fromNodeId), to = project.nodes.find((node) => node.id === edge.toNodeId); return from && to ? <line key={edge.id} x1={from.position.x + from.width} y1={from.position.y + from.height / 2} x2={to.position.x} y2={to.position.y + to.height / 2} stroke="currentColor" /> : null; })}
            </svg>
            {project.nodes.map((node) => <article key={node.id} className="absolute overflow-auto rounded-lg p-2" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, background: theme.node.panel }}>
                <h2 className="mb-2 text-sm font-medium">{node.title}</h2>
                {node.type === "image" ? <img src={node.metadata?.content} alt={node.title} className="h-[calc(100%-2rem)] w-full object-contain" /> : node.type === "video" ? <video src={node.metadata?.content} controls className="w-full" /> : node.type === "audio" ? <audio src={node.metadata?.content} controls className="w-full" /> : <pre className="whitespace-pre-wrap break-words text-sm">{node.metadata?.content || node.metadata?.prompt || ""}</pre>}
            </article>)}
        </InfiniteCanvas>
    </div>;
}

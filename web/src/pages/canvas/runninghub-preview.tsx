import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, ConfigProvider, Segmented, theme } from "antd";
import "antd/dist/reset.css";
import "@/styles/globals.css";
import { getAntThemeConfig } from "@/lib/app-theme";
import { RunningHubMappingEditor } from "./components/runninghub-mapping-editor";
import type { RunningHubMapping, RunningHubWorkflow } from "@/services/api/runninghub";

const workflow: RunningHubWorkflow = {
    workflowId: "2090742327726923778",
    images: ["5673", "5871"].map(nodeId => ({ nodeId, field: "image", label: `加载图像（${nodeId}） · image` })),
    prompts: ["4594", "5619"].map(nodeId => ({ nodeId, field: "text", label: `CLIP文本编码器（${nodeId}） · text` })),
    advancedTexts: ["5625", "5669", "5674", "5676", "5702", "5718"].map(nodeId => ({ nodeId, field: "text", label: `文本（${nodeId}）` })),
    outputs: ["4600", "5708", "5765", "5822"].map(nodeId => ({ nodeId, label: `${nodeId === "5765" ? "保存图像" : "预览图像"}（${nodeId}）` })),
};
const initial: RunningHubMapping = {
    inputs: [...workflow.images.map(item => ({ ...item, id: item.nodeId, field: "image", type: "image" as const, required: true })), ...workflow.prompts.map(item => ({ ...item, id: item.nodeId, field: "text", type: "text" as const, required: false }))],
    outputNodes: workflow.outputs.map(item => item.nodeId),
};

function PreviewContent({ dark, setDark }: { dark: boolean; setDark: (value: boolean) => void }) {
    const { token } = theme.useToken();
    const [mapping, setMapping] = useState(initial);
    const [width, setWidth] = useState("标准");
    return <main className="min-h-screen p-4 sm:p-6" style={{ background: token.colorBgLayout, color: token.colorText }}>
        <div className="mx-auto mb-5 flex max-w-3xl flex-wrap items-center gap-3">
            <strong className="mr-auto">RunningHub 配置预览</strong>
            <Segmented options={["浅色", "深色"]} value={dark ? "深色" : "浅色"} onChange={value => setDark(value === "深色")} />
            <Segmented options={["标准", "窄屏"]} value={width} onChange={setWidth} />
            <Button onClick={() => setMapping(initial)}>重置</Button>
        </div>
        <div className="mx-auto mb-4 max-w-3xl text-xs" style={{ color: token.colorTextSecondary }}>交互示例 · 修改仅用于预览，不保存到服务器</div>
        <div className="mx-auto rounded-2xl border p-4 sm:p-6" style={{ maxWidth: width === "窄屏" ? 390 : 760, borderColor: token.colorBorderSecondary, background: token.colorBgElevated }}>
            <h1 className="mb-5 text-lg font-semibold">输入与输出</h1>
            <RunningHubMappingEditor value={mapping} onChange={setMapping} workflow={workflow} />
        </div>
    </main>;
}

function Preview() {
    const [dark, setDark] = useState(true);
    return <ConfigProvider theme={getAntThemeConfig(dark)}><PreviewContent dark={dark} setDark={setDark} /></ConfigProvider>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Preview />);

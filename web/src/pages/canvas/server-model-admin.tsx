import { RunningHubMappingEditor } from "./components/runninghub-mapping-editor";
import { useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Tag, Upload } from "antd";
import { workspaceApi, jsonBody } from "@/services/api/workspace";
import { useServerModelStore, type ServerModel } from "@/stores/use-server-model-store";

import { getRunningHubSettings, saveRunningHubSettings, readRunningHubWorkflow, type RunningHubSettings, type RunningHubWorkflow } from "@/services/api/runninghub";

type ManagedModel = ServerModel & { baseUrl: string; enabled: boolean; hasKey: boolean; comfy?: { workflow: Record<string, unknown>; promptNode: string; sizeNode: string; outputNode: string } };
const capabilities = [{ value: "image", label: "图片" }, { value: "text", label: "文本" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
export function ServerModelAdmin() {
    const { message, modal } = App.useApp();
    const [models, setModels] = useState<ManagedModel[]>([]);
    const [editing, setEditing] = useState<ManagedModel | "new" | null>(null);
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [untagged, setUntagged] = useState(false);
    const tagOptions = [...new Set(models.filter(row => row.apiFormat === "runninghub").flatMap(row => row.tags || []))].sort().map(value => ({ value, label: value }));
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm();
    const [runningHubSettings, setRunningHubSettings] = useState<RunningHubSettings>({ hasKey: false });
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [apiKey, setApiKey] = useState("");
    const [workflow, setWorkflow] = useState<RunningHubWorkflow | null>(null);
    const readWorkflow = async (file?: File) => {
        setBusy(true);
        try {
            const result = await readRunningHubWorkflow(form.getFieldValue("model") || "", file ? JSON.parse(await file.text()) : undefined);
            setWorkflow(result);
            if (result.name && !form.getFieldValue("name")?.trim()) form.setFieldValue("name", result.name);
            form.setFieldsValue({ model: result.workflowId, runninghub: {
                inputs: [...result.images.map((item) => ({ ...item, type: "image" as const })), ...result.prompts.map((item) => ({ ...item, type: "text" as const }))].map((item) => ({ id: item.nodeId + "/" + item.field, nodeId: item.nodeId, field: item.field, label: item.label, type: item.type, required: item.type === "image" })),
                outputNodes: result.outputs.map((item) => item.nodeId),
            } });
            message.success("工作流已读取，请确认输入与输出；未提交生成任务");
        } catch (error) { message.error(String(error)); } finally { setBusy(false); }
    };
    const isComfy = Form.useWatch("apiFormat", form) === "comfyui";
    const isRunningHub = Form.useWatch("apiFormat", form) === "runninghub";
    const refresh = async () => { setRunningHubSettings(await getRunningHubSettings()); setModels(await workspaceApi<ManagedModel[]>("/admin/models")); await useServerModelStore.getState().load(); };
    useEffect(() => { void refresh().catch((error) => message.error(String(error))); }, []);
    const edit = (row: ManagedModel | "new") => { setWorkflow(null); form.resetFields(); form.setFieldsValue(row === "new" ? { apiFormat: "openai", capability: "image", enabled: true } : { ...row, apiKey: "", workflowJson: row.comfy ? JSON.stringify(row.comfy.workflow, null, 2) : "" }); setEditing(row); };
    const save = async () => {
        const fields = await form.validateFields().catch(() => { message.error(isRunningHub ? "请填写名称、工作流并确认输入输出映射" : "请完善必填项"); return null; });
        if (!fields) return;
        const { workflowJson, ...values } = fields;
        if (values.apiFormat === "comfyui") {
            try { values.comfy = { ...values.comfy, workflow: JSON.parse(workflowJson) }; }
            catch { message.error("工作流 JSON 格式不正确"); return; }
            values.capability = "image";
        } else { delete values.comfy; }
        if (values.apiFormat === "runninghub") { values.capability = "image"; delete values.apiKey; }
        else delete values.runninghub;
        setBusy(true);
        try { await workspaceApi(`/admin/models/${editing === "new" ? "new" : editing!.id}`, { method: "PUT", body: jsonBody(values) }); await refresh(); setEditing(null); message.success("服务器模型已保存"); }
        catch (error) { message.error(String(error)); } finally { setBusy(false); }
    };
    return <div className="space-y-4">
        <p>所有登录用户均可使用已启用模型。API Key 仅保存在服务器，调用费用由该账号承担。本地模型配置不受影响。</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <Space wrap><Button onClick={() => edit("new")}>添加服务器模型</Button><Button onClick={() => { edit("new"); form.setFieldsValue({ apiFormat: "runninghub", baseUrl: "https://www.runninghub.cn", enabled: runningHubSettings.hasKey }); }}>快速添加 RunningHub</Button></Space>
            <Space wrap><Button onClick={() => { setApiKey(""); setSettingsOpen(true); }}>RunningHub 设置</Button><Button onClick={() => void refresh().catch((error) => message.error(String(error)))}>刷新</Button></Space>
        </div>
        <Modal open={settingsOpen} title="RunningHub 设置" confirmLoading={busy} closable={!busy} maskClosable={!busy} cancelButtonProps={{ disabled: busy }} okButtonProps={{ disabled: !apiKey.trim() }} onCancel={() => { setSettingsOpen(false); setApiKey(""); }} onOk={async () => {
            setBusy(true);
            try { await saveRunningHubSettings(apiKey.trim()); setApiKey(""); setSettingsOpen(false); await refresh(); message.success("已更新全局 Key，新请求立即生效"); }
            catch (error) { message.error(String(error)); } finally { setBusy(false); }
        }}>
            <p className="mb-3">所有 RunningHub 模型统一使用此 Key。修改后新请求立即生效，运行中的任务继续使用启动时的 Key。</p>
            <Input.Password aria-label="RunningHub 全局 API Key" autoComplete="new-password" placeholder={runningHubSettings.hasKey ? "已配置；输入新 Key 替换" : "请输入 API Key"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
        </Modal>
        <Space wrap><Select className="min-w-64" mode="multiple" allowClear placeholder="按 RunningHub 标签筛选（匹配任意）" options={tagOptions} value={tagFilter} onChange={setTagFilter} /><label><input type="checkbox" checked={untagged} onChange={event => setUntagged(event.target.checked)} /> 包含未标记</label></Space>
        <Table rowKey="id" dataSource={models.filter(row => (!tagFilter.length && !untagged) || (row.apiFormat === "runninghub" && ((untagged && !row.tags?.length) || tagFilter.some(tag => row.tags?.includes(tag)))))} columns={[
            { title: "名称", dataIndex: "name" }, { title: "模型", dataIndex: "model" },
            { title: "标签", render: (_, row) => row.apiFormat === "runninghub" ? <Space wrap>{row.tags?.length ? row.tags.map(tag => <Tag key={tag}>{tag}</Tag>) : "未标记"}</Space> : "—" },
            { title: "类型", render: (_, row) => capabilities.find((item) => item.value === row.capability)?.label },
            { title: "状态", render: (_, row) => row.enabled ? "已启用" : "已停用" },
            { title: "操作", render: (_, row) => <Space><Button onClick={() => edit(row)}>编辑</Button><Button danger onClick={() => modal.confirm({ title: "删除服务器模型？", content: "引用此模型的画布需要重新选择模型。", onOk: async () => { await workspaceApi(`/admin/models/${row.id}`, { method: "DELETE" }); await refresh(); } })}>删除</Button></Space> },
        ]} />
        <Modal open={Boolean(editing)} title={editing === "new" ? "添加服务器模型" : "编辑服务器模型"} confirmLoading={busy} closable={!busy} maskClosable={!busy} cancelButtonProps={{ disabled: busy }} onCancel={() => setEditing(null)} onOk={save}>
            <Form form={form} layout="vertical" disabled={busy} onValuesChange={(changed) => { if ("model" in changed || "apiFormat" in changed) { setWorkflow(null); form.setFieldValue("runninghub", {}); } }}>
                <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input placeholder="例如：团队生图模型" /></Form.Item>
                <Form.Item name="apiFormat" label="接口格式" rules={[{ required: true }]}><Select onChange={(value) => { if (value === "comfyui" || value === "runninghub") form.setFieldValue("capability", "image"); if (value === "runninghub") form.setFieldValue("baseUrl", "https://www.runninghub.cn"); }} options={[{ value: "openai", label: "OpenAI 兼容" }, { value: "gemini", label: "Gemini" }, { value: "comfyui", label: "ComfyUI 文生图工作流" }, { value: "runninghub", label: "RunningHub 图片工作流" }]} /></Form.Item>
                <Form.Item hidden={isRunningHub} name="baseUrl" label="接口地址（需部署机器可访问）" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com" /></Form.Item>
                <Form.Item hidden={isRunningHub} name="apiKey" label={isComfy ? "API Key（无鉴权可留空；编辑时留空保留原值）" : editing !== "new" ? "API Key（留空保留原值）" : "API Key"} rules={[{ required: editing === "new" && !isComfy && !isRunningHub }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Form.Item name="model" label={isRunningHub ? "RunningHub 工作流链接或 ID" : isComfy ? "工作流标识" : "模型 ID"} rules={[{ required: true }]}><Input /></Form.Item>
                {isRunningHub && <>
                    <Form.Item name="tags" label="标签"><Select mode="tags" options={tagOptions} placeholder="选择或新建标签" /></Form.Item>
                    <Space className="mb-3" wrap><Button disabled={!runningHubSettings.hasKey || busy} loading={busy} onClick={() => void readWorkflow()}>读取工作流</Button><Upload accept=".json" showUploadList={false} beforeUpload={async (file) => { await readWorkflow(file); return false; }}><Button disabled={busy}>导入 API JSON</Button></Upload></Space>
                    <Form.Item name="runninghub" rules={[{ validator: (_, value) => value?.inputs && value?.outputNodes?.length && value.inputs.every((item: { label: string; nodeId: string; field: string }) => item.label.trim() && item.nodeId.trim() && item.field.trim()) ? Promise.resolve() : Promise.reject(new Error("请完善输入映射并选择图片输出")) }]}>
                        <RunningHubMappingEditor workflow={workflow} />
                    </Form.Item>
                </>}
                {isComfy && <>
                    <p>仅支持文生图。提示词、尺寸和数量由画布传入，其余参数使用工作流设置。参考图请求会被拒绝。</p>
                    <Upload accept=".json" showUploadList={false} beforeUpload={async (file) => {
                        try {
                            const value = JSON.parse(await file.text());
                            if (value.nodes) throw new Error("请导入 API 格式，编辑器格式需先转换");
                            form.setFieldValue("workflowJson", JSON.stringify(value, null, 2));
                        } catch (error) { message.error(String(error)); }
                        return false;
                    }}><Button>导入 API 工作流 JSON</Button></Upload>
                    <Form.Item name="workflowJson" label="API 工作流 JSON" rules={[{ required: true }]}><Input.TextArea rows={6} /></Form.Item>
                    <Form.Item name={["comfy", "promptNode"]} label="正面提示词节点 ID（CLIPTextEncode）" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["comfy", "sizeNode"]} label="尺寸与数量节点 ID（EmptySD3LatentImage）" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["comfy", "outputNode"]} label="图片输出节点 ID（SaveImage）" rules={[{ required: true }]}><Input /></Form.Item>
                </>}
                <Form.Item name="capability" label="生成类型" rules={[{ required: true }]}><Select disabled={isComfy || isRunningHub} options={capabilities} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Form>
        </Modal>
    </div>;
}

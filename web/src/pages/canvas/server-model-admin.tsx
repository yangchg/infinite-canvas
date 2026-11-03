import { useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Upload } from "antd";
import { workspaceApi, jsonBody } from "@/services/api/workspace";
import { useServerModelStore, type ServerModel } from "@/stores/use-server-model-store";

type ManagedModel = ServerModel & { baseUrl: string; enabled: boolean; hasKey: boolean; comfy?: { workflow: Record<string, unknown>; promptNode: string; sizeNode: string; outputNode: string } };
const capabilities = [{ value: "image", label: "图片" }, { value: "text", label: "文本" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
export function ServerModelAdmin() {
    const { message, modal } = App.useApp();
    const [models, setModels] = useState<ManagedModel[]>([]);
    const [editing, setEditing] = useState<ManagedModel | "new" | null>(null);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm();
    const isComfy = Form.useWatch("apiFormat", form) === "comfyui";
    const isRunningHub = Form.useWatch("apiFormat", form) === "runninghub";
    const refresh = async () => { setModels(await workspaceApi<ManagedModel[]>("/admin/models")); await useServerModelStore.getState().load(); };
    useEffect(() => { void refresh().catch((error) => message.error(String(error))); }, []);
    const edit = (row: ManagedModel | "new") => { form.resetFields(); form.setFieldsValue(row === "new" ? { apiFormat: "openai", capability: "image", enabled: true } : { ...row, apiKey: "", workflowJson: row.comfy ? JSON.stringify(row.comfy.workflow, null, 2) : "" }); setEditing(row); };
    const save = async () => {
        const fields = await form.validateFields();
        const { workflowJson, ...values } = fields;
        if (values.apiFormat === "comfyui") {
            try { values.comfy = { ...values.comfy, workflow: JSON.parse(workflowJson) }; }
            catch { message.error("工作流 JSON 格式不正确"); return; }
            values.capability = "image";
        } else { delete values.comfy; }
        if (values.apiFormat === "runninghub") values.capability = "image";
        else delete values.runninghub;
        setBusy(true);
        try { await workspaceApi(`/admin/models/${editing === "new" ? "new" : editing!.id}`, { method: "PUT", body: jsonBody(values) }); await refresh(); setEditing(null); message.success("服务器模型已保存"); }
        catch (error) { message.error(String(error)); } finally { setBusy(false); }
    };
    return <div className="space-y-4">
        <p>所有登录用户均可使用已启用模型。API Key 仅保存在服务器，调用费用由该账号承担。本地模型配置不受影响。</p>
        <Space><Button onClick={() => edit("new")}>添加服务器模型</Button><Button onClick={() => void refresh().catch((error) => message.error(String(error)))}>刷新</Button></Space>
        <Table rowKey="id" dataSource={models} columns={[
            { title: "名称", dataIndex: "name" }, { title: "模型", dataIndex: "model" },
            { title: "类型", render: (_, row) => capabilities.find((item) => item.value === row.capability)?.label },
            { title: "状态", render: (_, row) => row.enabled ? "已启用" : "已停用" },
            { title: "操作", render: (_, row) => <Space><Button onClick={() => edit(row)}>编辑</Button><Button danger onClick={() => modal.confirm({ title: "删除服务器模型？", content: "引用此模型的画布需要重新选择模型。", onOk: async () => { await workspaceApi(`/admin/models/${row.id}`, { method: "DELETE" }); await refresh(); } })}>删除</Button></Space> },
        ]} />
        <Modal open={Boolean(editing)} title={editing === "new" ? "添加服务器模型" : "编辑服务器模型"} confirmLoading={busy} onCancel={() => setEditing(null)} onOk={save}>
            <Form form={form} layout="vertical">
                <Form.Item name="name" label="显示名称" rules={[{ required: true }]}><Input placeholder="例如：团队生图模型" /></Form.Item>
                <Form.Item name="apiFormat" label="接口格式" rules={[{ required: true }]}><Select onChange={(value) => { if (value === "comfyui" || value === "runninghub") form.setFieldValue("capability", "image"); if (value === "runninghub") form.setFieldValue("baseUrl", "https://www.runninghub.cn"); }} options={[{ value: "openai", label: "OpenAI 兼容" }, { value: "gemini", label: "Gemini" }, { value: "comfyui", label: "ComfyUI 文生图工作流" }, { value: "runninghub", label: "RunningHub 单图工作流" }]} /></Form.Item>
                <Form.Item name="baseUrl" label="接口地址（需部署机器可访问）" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com" /></Form.Item>
                <Form.Item name="apiKey" label={isRunningHub ? "API Key（启用前必填；留空保留原密钥）" : isComfy ? "API Key（无鉴权可留空；编辑时留空保留原值）" : editing !== "new" ? "API Key（留空保留原值）" : "API Key"} rules={[{ required: editing === "new" && !isComfy && !isRunningHub }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Form.Item name="model" label={isRunningHub ? "RunningHub 工作流 ID" : isComfy ? "工作流标识" : "模型 ID"} rules={[{ required: true }]}><Input /></Form.Item>
                {isRunningHub && <>
                    <p>需要 1 张参考图，每次输出 1 张。尺寸及其他参数沿用云端工作流；草稿和提示词会上传 RunningHub，费用由此 Key 对应账号承担。未填写密钥时请保持停用。</p>
                    <Form.Item name={["runninghub", "promptNode"]} label="提示词节点 ID" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["runninghub", "promptField"]} label="提示词字段" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["runninghub", "imageNode"]} label="参考图节点 ID" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["runninghub", "imageField"]} label="参考图字段" rules={[{ required: true }]}><Input /></Form.Item>
                    <Form.Item name={["runninghub", "outputNode"]} label="图片输出节点 ID" rules={[{ required: true }]}><Input /></Form.Item>
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

import { useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table } from "antd";
import { workspaceApi, jsonBody } from "@/services/api/workspace";
import { useServerModelStore, type ServerModel } from "@/stores/use-server-model-store";

type ManagedModel = ServerModel & { baseUrl: string; enabled: boolean; hasKey: boolean };
const capabilities = [{ value: "image", label: "图片" }, { value: "text", label: "文本" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
export function ServerModelAdmin() {
    const { message, modal } = App.useApp();
    const [models, setModels] = useState<ManagedModel[]>([]);
    const [editing, setEditing] = useState<ManagedModel | "new" | null>(null);
    const [busy, setBusy] = useState(false);
    const [form] = Form.useForm();
    const refresh = async () => { setModels(await workspaceApi<ManagedModel[]>("/admin/models")); await useServerModelStore.getState().load(); };
    useEffect(() => { void refresh().catch((error) => message.error(String(error))); }, []);
    const edit = (row: ManagedModel | "new") => { form.resetFields(); form.setFieldsValue(row === "new" ? { apiFormat: "openai", capability: "image", enabled: true } : { ...row, apiKey: "" }); setEditing(row); };
    const save = async () => {
        const values = await form.validateFields();
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
                <Form.Item name="apiFormat" label="接口格式" rules={[{ required: true }]}><Select options={[{ value: "openai", label: "OpenAI 兼容" }, { value: "gemini", label: "Gemini" }]} /></Form.Item>
                <Form.Item name="baseUrl" label="接口地址（需部署机器可访问）" rules={[{ required: true }, { type: "url" }]}><Input placeholder="https://api.example.com" /></Form.Item>
                <Form.Item name="apiKey" label={editing !== "new" ? "API Key（留空保留原值）" : "API Key"} rules={[{ required: editing === "new" }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Form.Item name="model" label="模型 ID" rules={[{ required: true }]}><Input /></Form.Item>
                <Form.Item name="capability" label="生成类型" rules={[{ required: true }]}><Select options={capabilities} /></Form.Item>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
            </Form>
        </Modal>
    </div>;
}

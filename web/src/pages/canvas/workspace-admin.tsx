import { useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Space, Switch, Table, Tabs } from "antd";
import { useCanvasStore, type WorkspaceProject } from "@/stores/canvas/use-canvas-store";
import type { SessionUser } from "@/stores/use-session-store";
import { jsonBody, workspaceApi } from "@/services/api/workspace";
import { ServerModelAdmin } from "./server-model-admin";

type ManagedCanvas = { id: string; number: string; title: string; projectId: string; ownerId: string; ownerName: string; deleted: number; publishedId: string | null };
export function WorkspaceAdmin({ onClose }: { onClose: () => void }) {
    const { message, modal } = App.useApp();
    const groups = useCanvasStore((state) => state.groups);
    const [users, setUsers] = useState<SessionUser[]>([]);
    const [canvases, setCanvases] = useState<ManagedCanvas[]>([]);
    const [busy, setBusy] = useState(false);
    const [projectTitle, setProjectTitle] = useState("");
    const [membersProject, setMembersProject] = useState<WorkspaceProject | null>(null);
    const [memberIds, setMemberIds] = useState<string[]>([]);
    const [editUser, setEditUser] = useState<SessionUser | null>(null);
    const [rename, setRename] = useState<WorkspaceProject | null>(null);
    const [transfer, setTransfer] = useState<ManagedCanvas | null>(null);
    const [ownerId, setOwnerId] = useState<string>();
    const [form] = Form.useForm();
    const refresh = async () => {
        const [accounts, items] = await Promise.all([workspaceApi<SessionUser[]>("/admin/users"), workspaceApi<ManagedCanvas[]>("/admin/canvases")]);
        setUsers(accounts); setCanvases(items); await useCanvasStore.getState().load();
    };
    const act = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); await refresh(); } catch (error) { message.error(String(error)); } finally { setBusy(false); } };
    useEffect(() => { void act(async () => undefined); }, []);
    const patchProject = (id: string, patch: object) => workspaceApi(`/projects/${id}`, { method: "PATCH", body: jsonBody(patch) });
    return <Modal open title="项目与账号管理" width={1000} footer={null} onCancel={onClose}>
        <Tabs defaultActiveKey="projects" items={[
            { key: "models", label: "服务器模型", children: <ServerModelAdmin /> },
            { key: "projects", label: "项目", children: <div className="space-y-4">
                <Space.Compact block><Input placeholder="新项目名称" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /><Button disabled={!projectTitle.trim()} loading={busy} aria-label="创建项目" onClick={() => void act(async () => { await workspaceApi("/projects", { method: "POST", body: jsonBody({ title: projectTitle }) }); setProjectTitle(""); })}>创建项目</Button></Space.Compact>
                <Table rowKey="id" dataSource={groups} pagination={false} columns={[
                    { title: "项目", dataIndex: "title" },
                    { title: "状态", render: (_, row) => row.deleted ? "回收站" : row.archived ? "已归档" : "正常" },
                    { title: "操作", render: (_, row) => <Space wrap>
                        {row.deleted ? <Button onClick={() => void act(() => patchProject(row.id, { deleted: false }))}>恢复</Button> : <>
                            <Button onClick={() => { setRename(row); setProjectTitle(row.title); }}>重命名</Button>
                            <Button onClick={() => void act(async () => { const members = await workspaceApi<SessionUser[]>(`/projects/${row.id}/members`); setMemberIds(members.map((item) => item.id)); setMembersProject(row); })}>成员</Button>
                            <Button onClick={() => void act(() => patchProject(row.id, { archived: !row.archived }))}>{row.archived ? "恢复编辑" : "归档"}</Button>
                            <Button danger onClick={() => modal.confirm({ title: "将项目移入回收站？", content: "成员将无法访问项目，画布和附件会保留。", onOk: () => act(() => patchProject(row.id, { deleted: true })) })}>删除</Button>
                        </>}
                    </Space> },
                ]} />
            </div> },
            { key: "users", label: "账号", children: <Table rowKey="id" dataSource={users} columns={[
                { title: "账号", dataIndex: "username" }, { title: "名称", dataIndex: "displayName" },
                { title: "角色", render: (_, row) => row.admin ? "管理员" : "普通用户" },
                { title: "状态", render: (_, row) => row.disabled ? "已禁用" : "正常" },
                { title: "操作", render: (_, row) => <Button onClick={() => { setEditUser(row); form.setFieldsValue({ ...row, password: "" }); }}>编辑 / 重置密码</Button> },
            ]} /> },
            { key: "canvases", label: "画布管理", children: <Table rowKey="id" dataSource={canvases} columns={[
                { title: "编号", dataIndex: "number" },
                { title: "名称", dataIndex: "title" }, { title: "所有者", dataIndex: "ownerName" },
                { title: "项目", render: (_, row) => groups.find((group) => group.id === row.projectId)?.title },
                { title: "操作", render: (_, row) => <Space wrap>
                    <Button onClick={() => { setTransfer(row); setOwnerId(undefined); }}>转移所有权</Button>
                    <Button danger={!row.deleted} onClick={() => modal.confirm({ title: row.deleted ? "恢复画布？" : "将画布移入回收站？", onOk: () => act(() => workspaceApi(`/canvases/${row.id}/lifecycle`, { method: "PATCH", body: jsonBody({ deleted: !row.deleted }) })) })}>{row.deleted ? "恢复" : "删除"}</Button>
                    {row.publishedId && <Button onClick={() => void act(() => workspaceApi(`/canvases/${row.id}/publish`, { method: "DELETE" }))}>下架</Button>}
                </Space> },
            ]} /> },
        ]} />
        <Modal open={Boolean(membersProject)} title={`${membersProject?.title || ""}：项目成员`} onCancel={() => setMembersProject(null)} onOk={() => void act(async () => { await workspaceApi(`/projects/${membersProject!.id}/members`, { method: "PUT", body: jsonBody({ userIds: memberIds }) }); setMembersProject(null); })}>
            <p className="mb-3">管理员可以管理所有项目。普通用户仅能进入已分配的项目。</p><Select mode="multiple" className="w-full" value={memberIds} onChange={setMemberIds} options={users.map((item) => ({ value: item.id, label: `${item.displayName} (${item.username})` }))} />
        </Modal>
        <Modal open={Boolean(rename)} title="重命名项目" onCancel={() => { setRename(null); setProjectTitle(""); }} onOk={() => void act(async () => { await patchProject(rename!.id, { title: projectTitle }); setRename(null); setProjectTitle(""); })}><Input value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} /></Modal>
        <Modal open={Boolean(editUser)} title="编辑账号" onCancel={() => setEditUser(null)} onOk={() => void act(async () => { const values = await form.validateFields(); await workspaceApi(`/admin/users/${editUser!.id}`, { method: "PATCH", body: jsonBody({ ...values, password: values.password || undefined }) }); setEditUser(null); })}>
            <Form form={form} layout="vertical"><Form.Item name="displayName" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="admin" label="管理员" valuePropName="checked"><Switch /></Form.Item><Form.Item name="disabled" label="禁用账号" valuePropName="checked"><Switch /></Form.Item><Form.Item name="password" label="新密码（留空不修改）"><Input.Password autoComplete="new-password" /></Form.Item></Form>
        </Modal>
        <Modal open={Boolean(transfer)} title="转移画布所有权" onCancel={() => setTransfer(null)} onOk={() => void act(async () => { if (!ownerId) throw new Error("请选择新所有者"); await workspaceApi(`/canvases/${transfer!.id}/lifecycle`, { method: "PATCH", body: jsonBody({ ownerId }) }); setTransfer(null); })}>
            <p className="mb-3">新所有者必须能够访问该项目。转移会记录到管理日志。</p><Select className="w-full" value={ownerId} onChange={setOwnerId} options={users.filter((item) => !item.disabled).map((item) => ({ value: item.id, label: item.displayName }))} />
        </Modal>
    </Modal>;
}

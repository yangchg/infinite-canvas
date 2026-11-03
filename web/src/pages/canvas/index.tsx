import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Empty, Input, Modal, Select, Space, Tabs, Tag } from "antd";
import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useSessionStore } from "@/stores/use-session-store";
import { jsonBody, workspaceApi } from "@/services/api/workspace";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { readZip } from "@/lib/zip";
import { setImageBlob } from "@/services/image-storage";
import { setMediaBlob } from "@/services/file-storage";
import type { CanvasExportFile } from "@/types/canvas-export";
import { WorkspaceAdmin } from "./workspace-admin";

type PublicCanvas = Pick<CanvasProject, "id" | "number" | "title" | "ownerName" | "ownerId" | "publishedId" | "updatedAt">;
export default function CanvasPage() {
    const store = useCanvasStore();
    const user = useSessionStore((state) => state.user)!;
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const [search, setSearch] = useSearchParams();
    const [tab, setTab] = useState("mine");
    const [publicItems, setPublicItems] = useState<PublicCanvas[]>([]);
    const [busy, setBusy] = useState(false);
    const [adminOpen, setAdminOpen] = useState(false);
    const [rename, setRename] = useState<CanvasProject | null>(null);
    const [title, setTitle] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const group = store.groups.find((item) => item.id === store.selectedGroupId);
    const writable = Boolean(group && !group.archived && !group.deleted);
    const refreshPublic = async () => {
        if (!store.selectedGroupId || group?.deleted) { setPublicItems([]); return; }
        setPublicItems(await workspaceApi<PublicCanvas[]>(`/projects/${store.selectedGroupId}/public`));
    };
    useEffect(() => {
        let current = true;
        setPublicItems([]);
        if (store.selectedGroupId && !group?.deleted) void workspaceApi<PublicCanvas[]>(`/projects/${store.selectedGroupId}/public`).then((items) => { if (current) setPublicItems(items); }).catch((error) => { if (current) message.error(String(error)); });
        return () => { current = false; };
    }, [store.selectedGroupId, group?.deleted, message]);
    const act = async (action: () => Promise<unknown>) => {
        setBusy(true);
        try { await action(); } catch (error) { message.error(String(error)); } finally { setBusy(false); }
    };
    const open = (id: string) => navigate(`/canvas/${id}${search.toString() ? `?${search}` : ""}${window.location.hash}`);
    const create = () => { try { open(store.createProject()); } catch (error) { message.error(String(error)); } };
    useEffect(() => {
        const mode = search.get("mode");
        if (!writable || !["new", "recent"].includes(mode || "")) return;
        const next = new URLSearchParams(search); next.delete("mode"); setSearch(next, { replace: true });
        const recent = store.projects.find((item) => item.projectId === group?.id && !item.deleted);
        if (mode === "recent" && recent) open(recent.id); else create();
    }, [writable]);
    const publish = (item: CanvasProject) => modal.confirm({
        title: item.publishedId ? "更新项目公共版本" : "发布到项目公共画布",
        content: "发布当前草稿的快照，个人助手对话不会发布。请确认节点文本、图片和插件内容中没有需要保密的信息。后续编辑需要再次发布才会对其他成员可见。",
        onOk: async () => {
            await store.flush();
            const revision = useCanvasStore.getState().projects.find((row) => row.id === item.id)?.revision;
            await workspaceApi(`/canvases/${item.id}/publish`, { method: "POST", body: jsonBody({ revision }) });
            await store.load(); await refreshPublic();
        },
    });
    const usePublic = (item: PublicCanvas, kind: "usage" | "canvas") => act(async () => {
        const project = await workspaceApi<CanvasProject>(`/canvases/${item.id}/use`, { method: "POST", body: jsonBody({ kind }) });
        store.accept(project); open(project.id);
    });
    const importFile = (file?: File) => act(async () => {
        if (!file) return;
        const zip = await readZip(file);
        const manifest = zip.get("projects.json");
        if (!manifest) throw new Error("缺少画布清单");
        const data = JSON.parse(await manifest.text()) as CanvasExportFile;
        const importedKeys = new Map<string, string>();
        for (const item of data.projects) {
            for (const resource of item.files) {
                const blob = zip.get(resource.path);
                if (!blob) throw new Error("导入包缺少附件");
                const key = importedKeys.get(resource.storageKey) || `${resource.storageKey.split(":")[0]}:${nanoid()}`;
                importedKeys.set(resource.storageKey, key);
                await (resource.storageKey.startsWith("image:") ? setImageBlob : setMediaBlob)(key, blob.slice(0, blob.size, resource.mimeType));
            }
            const project = JSON.parse(JSON.stringify(item.project), (_key, value) => typeof value === "string" && importedKeys.has(value) ? importedKeys.get(value) : value);
            store.importProject(project);
        }
        await store.flush(); message.success("已导入服务器");
        if (input.current) input.current.value = "";
    });
    const items = store.projects.filter((item) => item.projectId === store.selectedGroupId && (tab === "trash" ? item.deleted : !item.deleted && (tab === "usage" ? item.kind === "usage" : item.kind !== "usage")));
    return <main className="h-full overflow-auto bg-background p-6 text-foreground">
        <div className="mx-auto max-w-6xl space-y-6">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div><h1 className="text-2xl font-semibold">项目与画布</h1><p className="mt-2 text-sm">{user.displayName} · {user.admin ? "管理员" : "普通用户"} · 画布保存在服务器</p></div>
                <Space wrap>
                    <Button onClick={() => void act(async () => { await store.load(); await refreshPublic(); })}>刷新</Button>
                    {user.admin && <Button onClick={() => setAdminOpen(true)}>项目与账号管理</Button>}
                    <Button onClick={() => void act(useSessionStore.getState().logout)}>退出登录</Button>
                </Space>
            </header>
            {store.error && <Alert title="尚未保存到服务器" description={store.error} type="error" action={<Button onClick={() => void act(store.flush)}>重试保存</Button>} />}
            <Space wrap>
                <Select aria-label="选择项目" style={{ minWidth: 240 }} placeholder="请选择项目" value={store.selectedGroupId || undefined} onChange={store.selectGroup} options={store.groups.filter((item) => !item.deleted).map((item) => ({ value: item.id, label: `${item.title}${item.archived ? "（已归档）" : ""}` }))} />
                <Button type="primary" disabled={!writable || busy} onClick={create}>新建私有画布</Button>
                <Button disabled={!writable || busy} onClick={() => input.current?.click()}>导入画布</Button>
                <input ref={input} type="file" accept=".zip" hidden onChange={(event) => void importFile(event.target.files?.[0])} />
            </Space>
            {!group ? <Empty description={user.admin ? "请先创建项目" : "暂无可访问项目，请联系管理员添加成员"} /> : <>
                {Boolean(group.archived) && <Alert title="项目已归档，仅可查看和导出；恢复项目后可以继续编辑。" type="info" />}
                <Tabs activeKey={tab} onChange={setTab} items={[{ key: "mine", label: "我的画布" }, { key: "public", label: "公共画布" }, { key: "usage", label: "我的使用记录" }, { key: "trash", label: "回收站" }]} />
                {tab === "public" ? <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {publicItems.map((item) => <article key={item.id} className="space-y-3 rounded-xl border border-current/10 p-5">
                        <h2 className="text-lg font-medium">{item.title}</h2><p className="select-text font-mono text-xs">编号：{item.number}</p><p>所有者：{item.ownerName}</p><p className="text-xs">发布于 {new Date(item.updatedAt).toLocaleString()}</p>
                        <Space wrap><Button onClick={() => navigate(`/canvas/public/${item.id}`)}>查看</Button><Button disabled={!writable || busy} onClick={() => void usePublic(item, "usage")}>使用</Button><Button disabled={!writable || busy} onClick={() => void usePublic(item, "canvas")}>复制到我的画布</Button>
                            {(user.admin || item.ownerId === user.id) && <Button disabled={!writable || busy} onClick={() => void act(async () => { await workspaceApi(`/canvases/${item.id}/publish`, { method: "DELETE" }); await store.load(); await refreshPublic(); })}>取消发布</Button>}
                        </Space>
                    </article>)}
                    {!publicItems.length && <Empty description="暂无公共画布" />}
                </div> : <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {items.map((item) => <article key={item.id} className="space-y-3 rounded-xl border border-current/10 p-5">
                        <h2 className="text-lg font-medium">{item.title}</h2>
                        <p className="select-text font-mono text-xs">编号：{item.number || "保存后分配"}</p>
                        <p><Tag>{item.kind === "usage" ? "个人使用记录" : item.publishedId ? "已发布" : "私有"}</Tag>所有者：{item.ownerName}</p>
                        {item.sourceVersion && <p className="text-xs break-all">来源版本：{item.sourceVersion}</p>}
                        <Space wrap>
                            {item.deleted ? <Button disabled={!writable || busy} onClick={() => void act(async () => { await workspaceApi(`/canvases/${item.id}/lifecycle`, { method: "PATCH", body: jsonBody({ deleted: false }) }); await store.load(); })}>恢复为私有画布</Button> : <>
                                <Button onClick={() => open(item.id)}>{group.archived ? "查看" : item.kind === "usage" ? "继续使用" : "打开"}</Button>
                                <Button disabled={!writable} onClick={() => { setRename(item); setTitle(item.title); }}>重命名</Button>
                                {item.kind !== "usage" && <Button disabled={!writable || busy} onClick={() => publish(item)}>{item.publishedId ? "更新发布" : "发布"}</Button>}
                                <Button danger disabled={!writable || busy} onClick={() => modal.confirm({ title: "移入回收站？", content: "同时取消该画布的公共发布。", onOk: async () => { await store.deleteProjects([item.id]); await refreshPublic(); } })}>删除</Button>
                            </>}
                            <Button onClick={() => void act(() => exportCanvasProjects([item], item.title))}>导出</Button>
                        </Space>
                    </article>)}
                    {!items.length && <Empty description="暂无画布" />}
                </div>}
            </>}
        </div>
        <Modal open={Boolean(rename)} title="重命名画布" onCancel={() => setRename(null)} onOk={() => void act(async () => { if (rename && title.trim()) { store.renameProject(rename.id, title); await store.flush(); setRename(null); } })}><Input value={title} onChange={(event) => setTitle(event.target.value)} /></Modal>
        {adminOpen && <WorkspaceAdmin onClose={() => setAdminOpen(false)} />}
    </main>;
}

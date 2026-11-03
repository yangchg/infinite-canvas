import { useEffect, useState } from "react";
import { Alert, App, Button, Form, Input, Segmented, Spin } from "antd";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useSessionStore } from "@/stores/use-session-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function RequireSession() {
    const { ready, user, error, load } = useSessionStore();
    const hydrated = useCanvasStore((state) => state.hydrated);
    const canvasError = useCanvasStore((state) => state.error);
    const location = useLocation();
    useEffect(() => { void load(); }, [load]);
    useEffect(() => { if (user) void useCanvasStore.getState().load(); }, [user]);
    if (!ready) return <Spin fullscreen />;
    if (error) return <Alert title="无法连接账号服务" description={error} type="error" action={<Button onClick={() => void load()}>重试</Button>} />;
    if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    if (!hydrated) return canvasError ? <Alert title="画布加载失败" description={canvasError} type="error" action={<Button onClick={() => void useCanvasStore.getState().load()}>重试</Button>} /> : <Spin fullscreen />;
    return <Outlet />;
}

export default function LoginPage() {
    const [register, setRegister] = useState(false);
    const [busy, setBusy] = useState(false);
    const { message } = App.useApp();
    const authenticate = useSessionStore((state) => state.authenticate);
    return <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-sm space-y-6">
            <h1 className="text-2xl font-semibold">无限画布</h1>
            <p>登录后管理项目与画布，内容保存在部署服务器。</p>
            <Segmented options={[{ label: "登录", value: "login" }, { label: "注册", value: "register" }]} value={register ? "register" : "login"} onChange={(value) => setRegister(value === "register")} />
            <Form layout="vertical" onFinish={async (values) => { setBusy(true); try { await authenticate(register, values); } catch (error) { message.error(String(error)); } finally { setBusy(false); } }}>
                <Form.Item name="username" label="账号" rules={[{ required: true }, { pattern: /^[a-zA-Z0-9_.-]+$/, message: "使用字母、数字、点、下划线或横线" }]}><Input autoComplete="username" /></Form.Item>
                {register && <Form.Item name="displayName" label="显示名称"><Input /></Form.Item>}
                <Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password autoComplete={register ? "new-password" : "current-password"} /></Form.Item>
                <Button block type="primary" htmlType="submit" loading={busy} aria-label={register ? "注册账号" : "登录账号"}>{register ? "注册" : "登录"}</Button>
            </Form>
            {register && <p className="text-sm">注册账号为普通用户。项目由管理员创建并分配成员。</p>}
        </div>
    </main>;
}

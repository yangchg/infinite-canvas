import { useState } from "react";
import { App, Button, Dropdown, Form, Input, Modal } from "antd";
import { useSessionStore } from "@/stores/use-session-store";
import { jsonBody, workspaceApi } from "@/services/api/workspace";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function AccountMenu() {
    const { user, logout } = useSessionStore();
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [form] = Form.useForm();
    if (!user) return null;
    return <>
        <Dropdown popupRender={(menu) => <div data-canvas-no-zoom>{menu}</div>} trigger={["click"]} menu={{ items: [
            { key: "password", label: "修改密码", onClick: () => setOpen(true) },
            { key: "logout", label: "退出登录", onClick: () => void logout().catch((error) => message.error(String(error))) },
        ] }}><Button type="text" data-canvas-no-zoom>{user.displayName}</Button></Dropdown>
        <Modal title="修改密码" open={open} onCancel={() => setOpen(false)} onOk={async () => {
            try {
                const values = await form.validateFields();
                await useCanvasStore.getState().flush();
                await workspaceApi("/auth/password", { method: "POST", body: jsonBody(values) });
                window.location.assign("/login");
            } catch (error) { message.error(String(error)); }
        }}>
            <Form form={form} layout="vertical"><Form.Item name="currentPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="password" label="新密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item></Form>
        </Modal>
    </>;
}

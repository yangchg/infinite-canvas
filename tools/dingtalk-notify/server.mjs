import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// This optional local service owns app secrets. It never exposes tokens to the canvas.
export function createNotifier(config, { fetchImpl = fetch, records = new Map(), save = async () => {} } = {}) {
    const tokens = new Map();
    const pending = new Map();
    const channels = config.channels || [];
    const channelFor = (id) => {
        const channel = channels.find((item) => item.id === id);
        if (!channel) throw new Error('通知应用不存在，请检查本地配置。');
        return channel;
    };
    async function api(path, token, body) {
        const response = await fetchImpl(`https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`钉钉接口 HTTP ${response.status}`);
        const data = await response.json();
        // Do not return upstream messages that may echo credentials or request contents.
        if (data.errcode !== 0) throw Object.assign(new Error(`钉钉接口错误码 ${data.errcode}，请检查应用权限、可用范围和员工 ID。`), { rejected: true });
        return data;
    }
    async function tokenFor(channel) {
        const cached = tokens.get(channel.id);
        if (cached && cached.expires > Date.now()) return cached.value;
        const response = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appKey: channel.appKey, appSecret: channel.appSecret }),
        });
        if (!response.ok) throw new Error(`获取钉钉令牌失败（HTTP ${response.status}），请检查应用凭据。`);
        const data = await response.json();
        if (!data.accessToken || !Number.isFinite(data.expireIn)) throw new Error('钉钉令牌响应无效。');
        tokens.set(channel.id, { value: data.accessToken, expires: Date.now() + data.expireIn * 1000 });
        return data.accessToken;
    }
    const summarize = (record) => ({ state: record.state, message: record.message, retryable: record.state === 'failed' && !record.taskId });
    async function send(input) {
        if (typeof input.eventId !== 'string' || !input.eventId) throw new Error('缺少通知事件 ID。');
        if (pending.has(input.eventId)) return pending.get(input.eventId);
        if (records.has(input.eventId)) return summarize(records.get(input.eventId));
        const channel = channelFor(input.channel);
        const users = [...new Set(input.users || [])];
        if (!users.length || users.some((id) => !channel.users.some((user) => user.id === id))) throw new Error('请从本地应用配置中选择有效员工。');
        if (!['success', 'failure', 'canceled'].includes(input.status)) throw new Error('无效执行结果。');
        if (typeof input.canvas !== 'string' || typeof input.node !== 'string' || ![input.succeeded, input.failed, input.elapsedSeconds].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('通知内容无效。');
        const work = (async () => {
            const record = { channel: channel.id, users, state: 'unknown', message: '发送结果未知，请勿重复发送。' };
            records.set(input.eventId, record);
            // Persist before sending: after interruption, never repeat a potentially accepted message.
            await save(records);
            let sending = false;
            try {
                const token = await tokenFor(channel);
                const label = { success: '成功', failure: '失败', canceled: '已取消' }[input.status];
                const details = input.details || {};
                const description = [['生成类型', details.kind], ['输出方式', details.output], ['模型', details.model], ['参数', details.parameters], ['引用素材', details.references]].filter(([, value]) => typeof value === 'string' && value.trim()).map(([name, value]) => `${name}：${value}`).join('\n');
                const prompt = typeof details.prompt === 'string' && details.prompt.trim() ? `\n\n生成内容（实际提示词）：\n${details.prompt.trim()}` : '';
                const text = `画布生成${label}\n画布：${input.canvas}\n配置：${input.node}${description ? `\n${description}` : ''}${prompt}\n\n成功 ${input.succeeded} 项，失败 ${input.failed} 项\n耗时：${input.elapsedSeconds} 秒\n${input.status === 'failure' ? '请在画布中查看生成错误详情。\n' : ''}运行：${input.eventId}`;
                sending = true;
                const data = await api('topapi/message/corpconversation/asyncsend_v2', token, {
                    agent_id: channel.agentId, userid_list: users.join(','), to_all_user: false,
                    msg: { msgtype: 'text', text: { content: text } },
                });
                if (data.task_id == null) throw new Error('钉钉未返回任务 ID，请勿重复发送。');
                Object.assign(record, { taskId: data.task_id, state: 'submitted', message: '已提交钉钉，待查询发送结果（不代表员工已读）' });
            } catch (error) { record.message = error.message; if (!sending || error.rejected) record.state = 'failed'; }
            await save(records);
            return summarize(record);
        })();
        pending.set(input.eventId, work);
        try { return await work; } finally { pending.delete(input.eventId); }
    }
    async function result(eventId) {
        if (pending.has(eventId)) await pending.get(eventId);
        const record = records.get(eventId);
        if (!record) return { state: 'unknown', message: '未找到发送记录，无法确认是否送达。' };
        if (!record.taskId || record.state === 'delivered' || record.state === 'failed') return summarize(record);
        const channel = channelFor(record.channel);
        const data = await api('topapi/message/corpconversation/getsendresult', await tokenFor(channel), { agent_id: channel.agentId, task_id: record.taskId });
        const info = data.send_result;
        if (info) {
            const failed = [...(info.failed_user_id_list || []), ...(info.invalid_user_id_list || []), ...(info.forbidden_user_id_list || [])];
            // An empty result can mean the async task is still pending.
            if (failed.length) Object.assign(record, { state: 'failed', message: `发送未全部成功：${failed.length} 位员工失败或不在应用可用范围。` });
            else if (record.users.every((id) => [...(info.read_user_id_list || []), ...(info.unread_user_id_list || [])].includes(id))) Object.assign(record, { state: 'delivered', message: '钉钉已发送工作通知（不代表全部已读）' });
            await save(records);
        }
        return summarize(record);
    }
    return { channels: () => channels.map(({ id, name, users }) => ({ id, name, users })), send, result };
}

export function createNotificationServer(config, notifier) {
    return http.createServer(async (req, res) => {
        const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
        if (req.method === 'GET' && req.url === '/health') return reply(200, { service: 'canvas-dingtalk-notify' });
        // The browser uses same-origin Nginx. No CORS grants or arbitrary recipients.
        if (req.headers.origin && !config.allowedOrigins?.includes(req.headers.origin)) return reply(403, { error: '来源未获授权。' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: '拒绝跨站通知请求。' });
        try {
            if (req.method === 'GET' && req.url === '/channels') return reply(200, notifier.channels());
            if (req.method !== 'POST' || !['/send', '/result'].includes(req.url)) return reply(404, { error: '接口不存在。' });
            if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON 请求。' });
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            reply(200, req.url === '/send' ? await notifier.send(body) : await notifier.result(body.eventId));
        } catch (error) { reply(400, { error: error instanceof SyntaxError ? 'JSON 格式错误。' : error.message }); }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const configFile = process.env.DINGTALK_CONFIG || fileURLToPath(new URL('./config.local.json', import.meta.url));
    const ledgerFile = fileURLToPath(new URL('./data/deliveries.json', import.meta.url));
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    let records = new Map();
    try { records = new Map(JSON.parse(await readFile(ledgerFile, 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let saving = Promise.resolve();
    const save = (map) => {
        const snapshot = JSON.stringify([...map]);
        saving = saving.then(async () => {
            await mkdir(dirname(ledgerFile), { recursive: true });
            await writeFile(`${ledgerFile}.tmp`, snapshot, { mode: 0o600 });
            await rename(`${ledgerFile}.tmp`, ledgerFile);
        });
        return saving;
    };
    createNotificationServer(config, createNotifier(config, { records, save })).listen(17374, '127.0.0.1');
}

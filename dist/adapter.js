/**
 * MiniMax Code 适配器：把「本机客户端登录态」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 与 waygate-qoder 同构（同一个 core 骨架），差异只有三处：
 *   · 凭证：读客户端**明文** auth.json（无需解密，比 Qoder 简单）；
 *   · 协议：上游是 **Anthropic 兼容**（`/mavis/api/v1/llm/v1/messages`），不是自研签名；
 *   · ⚠️ 有**凭证互斥**问题（见 README），必须给用户明确告警。
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { commandDir, } from '@waygate/core';
import { join } from 'node:path';
import { MinimaxTokenManager, clientAuthFile, credentialPath, readClientCredential, readSavedCredential, saveCredential, } from './credential.js';
import { CredentialError, UpstreamError } from './errors.js';
import { anthropicToOpenAiSse } from './protocol/stream-decode.js';
import { toAnthropicRequest } from './protocol/translate.js';
export const DEFAULT_MMCODE_BASE_URL = 'https://agent.minimax.cn';
export const DEFAULT_MMCODE_CHAT_PATH = '/mavis/api/v1/llm/v1/messages';
/**
 * MiniMax 模型清单：上游**没有**清单端点（实测 `/mavis/api/v1/llm/v1/models` 恒 503），
 * 故用内置清单（与 relay 的种子一致）。这是「目录 = 接口清单」原则的**唯一例外** ——
 * 上游确实不提供，不编造其他来源，只列已知可用的这几个。
 */
export const MINIMAX_MODELS = [
    { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
    { id: 'MiniMax-M3.1-Flash-Preview', displayName: 'MiniMax M3.1 Flash Preview' },
    { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
];
/** 追加一条 OAuth 行（`~/.waygate/mmcode/oauth.json`），让 token 刷新可独立记录过期时间。 */
export function statePath() {
    return join(commandDir('mmcode'), 'oauth.json');
}
export function createMmcodeAdapter(opts = {}) {
    const baseUrl = (opts.baseUrl ?? DEFAULT_MMCODE_BASE_URL).replace(/\/+$/, '');
    const chatPath = opts.chatPath ?? DEFAULT_MMCODE_CHAT_PATH;
    const tokens = new MinimaxTokenManager((line) => process.stdout.write(`[mmcode] ${line}\n`));
    return {
        command: 'mmcode',
        displayName: 'MiniMax Code',
        defaultPort: 8788,
        upstreamLabel: `${baseUrl}  (Anthropic 兼容)`,
        // 注意：MiniMax 无需登录态就能列模型 —— 用内置清单（上游无清单端点）。
        async credentialStatus() {
            const saved = readSavedCredential();
            if (saved) {
                const left = saved.expiresAt ? Math.round((saved.expiresAt - Date.now()) / 60000) : null;
                const state = left !== null && left > 0 ? `access 有效约 ${left} 分钟` : 'access 可能已过期（下次请求会自动刷新）';
                return { ok: true, detail: `${state}${saved.account ? `（账号 ${saved.account}）` : ''}`, source: credentialPath() };
            }
            try {
                const c = readClientCredential();
                return { ok: true, detail: `已从客户端读取登录态${c.account ? `（${c.account}）` : ''} —— 建议跑一次 mmcode login 落盘`, source: clientAuthFile() };
            }
            catch (err) {
                return { ok: false, detail: err.message };
            }
        },
        async login() {
            const cred = readClientCredential();
            const path = saveCredential(cred);
            /* 独立的状态文件：记录过期时刻，便于 doctor 展示（凭证本体在 credential.json）。 */
            writeFileSync(statePath(), JSON.stringify({ expiresAt: cred.expiresAt, account: cred.account ?? null }, null, 2) + '\n', { mode: 0o600 });
            try {
                chmodSync(statePath(), 0o600);
            }
            catch {
                /* Windows 语义有限 */
            }
            const left = cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 60000) : null;
            process.stdout.write(`已读取客户端登录态${cred.account ? `（账号 ${cred.account}）` : ''}\n` +
                `已保存到 ${path}\n` +
                (left !== null ? `access token 剩余约 ${left} 分钟（到期自动刷新）\n` : '') +
                `\n⚠️  提醒：MiniMax 同一账号只能有一个有效会话 —— 本工具与官方客户端同时登录同一账号会互相踢下线。\n` +
                `    建议给本工具配专用账号（与日常使用的客户端分开）。\n`);
        },
        async listModels() {
            /* 上游无清单端点（实测 503）—— 用内置清单，见 MINIMAX_MODELS 注释。 */
            return MINIMAX_MODELS;
        },
        async doctorChecks() {
            const checks = [];
            /* [复核修正] 此前 .catch(()=>null) 吞掉了所有网络错误 → 「上游连通」恒报 ✓。
               fetch 只在网络不可达（DNS/超时/拒连）时抛错；HTTP 404/502 不抛（反而证明可达）。 */
            try {
                await fetch(`${baseUrl}/mavis/api/v1/llm/v1/models`, { signal: AbortSignal.timeout(8000) });
                checks.push({ name: '上游连通', ok: true, detail: `${baseUrl} 可达` });
            }
            catch (err) {
                checks.push({ name: '上游连通', ok: false, detail: err.message });
            }
            /* 取一次 token：既验证刷新链是否可用，也把轮换写回（doctor 顺手做体检）。 */
            try {
                const t = await tokens.accessToken();
                checks.push({ name: '令牌刷新', ok: true, detail: `可刷新（${t.slice(0, 8)}…）` });
            }
            catch (err) {
                checks.push({ name: '令牌刷新', ok: false, detail: err.message });
            }
            return checks;
        },
        async chat(body, signal) {
            const token = await tokens.accessToken();
            const payload = JSON.stringify(toAnthropicRequest(body));
            const res = await fetch(`${baseUrl}${chatPath}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    accept: 'text/event-stream',
                    'anthropic-version': '2023-06-01',
                    'user-agent': 'MiniMaxCode',
                },
                body: payload,
                signal,
            });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                if (res.status === 401 || res.status === 403) {
                    throw new CredentialError(`上游鉴权失败（HTTP ${res.status}）—— 令牌可能已被官方客户端顶掉或过期：在客户端重新登录后跑一次 mmcode login`);
                }
                throw new UpstreamError(`上游 HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
            }
            /* 上游 Anthropic 事件流 → OpenAI SSE（core 负责把流吐给客户端）。 */
            return { stream: res.body.pipeThrough(anthropicToOpenAiSse()), status: 200 };
        },
    };
}

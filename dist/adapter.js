/**
 * MiniMax Code 适配器：把「官方 OAuth 设备授权登录取到的凭证」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 与 waygate-qoder / waygate-workbuddy 同构（同一个 core 骨架），差异在于：
 *   · 凭证：走 **官方 OAuth 设备授权**（`mmcode login`），**不读本机客户端、不解密**；
 *     这样服务器（无反代目标机的桌面客户端）也能自助登录，无需人工注入 token；
 *   · 协议：上游是 **Anthropic 兼容**（`/mavis/api/v1/llm/v1/messages`），不是自研签名；
 *   · ⚠️ 有**凭证互斥**问题（见 README），必须给用户明确告警。
 */
import {} from 'waygate-core';
import { LOGIN_WAIT_MS, MinimaxTokenManager, PendingLoginError, credentialPath, credentialSummary, pollDeviceLogin, readSavedCredential, startDeviceLogin, } from './credential.js';
import { CredentialError, UpstreamError } from './errors.js';
import { MinimaxActivity, renderCheckin, renderCredits } from './activity.js';
import { anthropicToOpenAiSse } from './protocol/stream-decode.js';
import { toAnthropicRequest } from './protocol/translate.js';
export const DEFAULT_MMCODE_BASE_URL = 'https://agent.minimax.cn';
export const DEFAULT_MMCODE_CHAT_PATH = '/mavis/api/v1/llm/v1/messages';
/**
 * MiniMax 内置模型清单 —— **仅作回落**（v0.3.5 起）。
 *
 * 此前注释称「上游没有清单端点（实测 /mavis/api/v1/llm/v1/models 恒 503）」，
 * 那是**测错了路径**：清单端点是 `/mavis/api/v1/models`（不带 `llm/v1` 段，
 * 与 chat 端点前缀不同）。2026-10-17 实测该端点**无需鉴权**即可返回
 *   `{version, ttlSeconds, providers:[{providerId:'minimax', config:{models:{...}}}]}`
 *   —— 当前 4 个模型，与本清单一致。
 *
 * 故改为「真拉取 + 本清单回落」：上游新增模型能自动跟上（不必发版），
 * 拉取失败（离线 / 端点变更）时退回这里，保证 `mmcode models` 永远有输出。
 */
export const MINIMAX_MODELS = [
    { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
    { id: 'MiniMax-M3.1-Flash-Preview', displayName: 'MiniMax M3.1 Flash Preview' },
    { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
    { id: 'MiniMax-M2.7-highspeed', displayName: 'MiniMax M2.7 Highspeed' },
];
/** 清单端点（相对 baseUrl）。与 chat 端点不同前缀 —— 这是当初测错的地方。 */
export const MODELS_PATH = '/mavis/api/v1/models';
/** 拉取超时：清单是启动路径上的调用，不能拖慢 `mmcode serve`。 */
const MODELS_TIMEOUT_MS = 8_000;
/**
 * 拉上游真清单。失败 / 结构不符 / 空清单 → 返回 null（调用方回落内置清单）。
 *
 * **不带 access token**：实测该端点无需鉴权（带假 token 反而 401 —— 上游若收到
 * Authorization 会去校验它）。不带即匿名可读，也就不依赖登录态，`mmcode models`
 * 在未登录时同样可用。
 */
export async function pullMinimaxModels(baseUrl) {
    try {
        const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${MODELS_PATH}`, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        const models = body.providers?.find((p) => p.providerId === 'minimax')?.config?.models;
        if (!models || typeof models !== 'object')
            return null;
        const entries = Object.entries(models)
            .filter(([id]) => typeof id === 'string' && id.length > 0)
            .map(([id, m]) => ({
            id,
            /* 上游 name 是短名（如 `M2.7`），补上厂商前缀便于客户端里辨认。 */
            displayName: typeof m?.name === 'string' && m.name ? `MiniMax ${m.name}` : id,
        }));
        return entries.length > 0 ? entries : null;
    }
    catch {
        /* 网络不可达 / 超时 / 坏 JSON —— 一律回落，不向调用方抛（清单不是关键路径）。 */
        return null;
    }
}
/**
 * 轮询进度行 —— 用 `\r` 覆盖同一行，不刷屏。
 *
 * 没有它，用户面对的是最长 2 分钟的**完全静默**（实测），分不清"在等"还是"卡死了"。
 */
function tickTo(out) {
    return ({ waitedMs, remainingMs }) => {
        const w = Math.round(waitedMs / 1000);
        const r = Math.round(remainingMs / 1000);
        out.write(`\r  ⏳ 等待授权中… ${w}s（最多再等 ${r}s，按 Ctrl+C 可中断）   `);
    };
}
/**
 * 登录成功后必讲的互斥告警 —— 设备授权**不解除**它。
 *
 * 走 OAuth 只是让「服务器上自助登录」成为可能，MiniMax 的
 * 「同一账号同时只有一个有效会话」规则没有变：这个账号一旦在别处登过
 * （桌面客户端或官方 `mcode` CLI），本工具手里的 refresh token 立刻作废。
 */
function mutualExclusionNotice() {
    return ('\n⚠️  凭证互斥（必读）：MiniMax 同一账号只能有一个有效会话。\n' +
        '    请给本工具用**专用账号**，并且**永不用它登桌面客户端或官方 mcode CLI** ——\n' +
        '    只要在别处登录一次，这里的凭证就会被顶掉（表现为 401，需重跑 mmcode login）。\n');
}
export function createMmcodeAdapter(opts = {}) {
    const baseUrl = (opts.baseUrl ?? DEFAULT_MMCODE_BASE_URL).replace(/\/+$/, '');
    const chatPath = opts.chatPath ?? DEFAULT_MMCODE_CHAT_PATH;
    const tokens = new MinimaxTokenManager((line) => process.stdout.write(`[mmcode] ${line}\n`));
    const activity = new MinimaxActivity(() => tokens.accessToken());
    return {
        command: 'mmcode',
        displayName: 'MiniMax Code',
        defaultPort: 8788,
        upstreamLabel: `${baseUrl}  (Anthropic 兼容)`,
        // 模型清单走公开的 /mavis/api/v1/models（无需登录）；这里说明的是**聊天**所需凭证。
        loginHint: '登录（官方 OAuth 设备授权；按提示在浏览器完成授权）',
        /** [专属子命令] MiniMax 的签到与积分 —— 用本工具维护的令牌代签，无需开客户端。 */
        extraCommands: [
            {
                name: 'login-poll',
                summary: `完成登录：轮询取票（浏览器授权后执行；\`login\` 等待超时也用这条）`,
                usage: 'login-poll',
                async run() {
                    try {
                        const cred = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(process.stdout));
                        return '✓ 登录成功 → ' + credentialPath() + '\n' + credentialSummary() + '\n' + mutualExclusionNotice();
                    }
                    catch (err) {
                        if (err instanceof PendingLoginError) {
                            return '⏳ 还没看到你的授权完成 —— 请先在浏览器里打开链接完成授权，然后重跑：mmcode login-poll';
                        }
                        throw err;
                    }
                },
            },
            {
                name: 'checkin',
                summary: '每日签到领积分（用本工具令牌代签，无需开客户端）',
                usage: 'checkin',
                async run({ json }) {
                    const r = await activity.checkin();
                    return json ? JSON.stringify(r, null, 2) : renderCheckin(r);
                },
            },
            {
                name: 'credits',
                summary: '查询积分账本（剩余/已消耗/累计，精确到 0.01）',
                usage: 'credits',
                async run({ json }) {
                    const l = await activity.credits();
                    return json ? JSON.stringify(l, null, 2) : renderCredits(l);
                },
            },
        ],
        async credentialStatus() {
            const saved = readSavedCredential();
            if (!saved) {
                return { ok: false, detail: '未登录 —— 跑 `mmcode login`（浏览器授权一次）', source: credentialPath() };
            }
            const left = saved.expiresAt ? Math.round((saved.expiresAt - Date.now()) / 60000) : null;
            const state = left !== null && left > 0 ? `access 有效约 ${left} 分钟` : 'access 可能已过期（下次请求会自动刷新）';
            return { ok: true, detail: `${state}${saved.account ? `（账号 ${saved.account}…）` : ''}`, source: credentialPath() };
        },
        /**
         * 登录 = 官方 OAuth 设备授权（`mmcode login`）。
         *
         * **原地等 2 分钟**：打印授权链接后就地轮询，用户在浏览器点完授权、终端**自动**继续，
         * 不用像 WorkBuddy 那样手动回来再跑一次。
         * 超时（或用户没在 2 分钟内完成）→ 抛 `PendingLoginError`，此时**保留 state**并提示
         * 改用 `mmcode login-poll` 续跑（设备码本身有效期 5 分钟）。
         */
        async login() {
            const state = await startDeviceLogin();
            const out = process.stdout;
            out.write('请用浏览器打开下面的链接完成授权（用你的 MiniMax 账号）：\n\n' +
                `  ${state.verificationUriComplete}\n\n` +
                `  短码：${state.userCode}（链接已含，直接打开即可）\n\n` +
                `授权完成后本终端会**自动继续**（最多等 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒）。\n`);
            try {
                const cred = await pollDeviceLogin(LOGIN_WAIT_MS, tickTo(out));
                out.write('\n✓ 登录成功 → ' + credentialPath() + '\n' + credentialSummary() + '\n' + mutualExclusionNotice());
            }
            catch (err) {
                if (err instanceof PendingLoginError) {
                    out.write(`\n⏳ 等了 ${Math.round(LOGIN_WAIT_MS / 1000)} 秒还没看到授权完成。\n` +
                        '   完成浏览器授权后，回来执行：mmcode login-poll\n' +
                        '   （设备码 5 分钟内有效；超过就得重新跑 mmcode login。）\n');
                    throw err;
                }
                throw err;
            }
        },
        async listModels() {
            /* v0.3.5：真拉取 /mavis/api/v1/models（无需鉴权），失败回落内置清单。
               此前返回硬编码常量 —— 上游新增模型时必须发版才能跟上。 */
            return (await pullMinimaxModels(baseUrl)) ?? MINIMAX_MODELS;
        },
        async doctorChecks() {
            const checks = [];
            /* [复核修正] 此前 .catch(()=>null) 吞掉了所有网络错误 → 「上游连通」恒报 ✓。
               fetch 只在网络不可达（DNS/超时/拒连）时抛错；HTTP 404/502 不抛（反而证明可达）。 */
            try {
                await fetch(`${baseUrl}${MODELS_PATH}`, { signal: AbortSignal.timeout(8000) });
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

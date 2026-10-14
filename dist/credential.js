/**
 * MiniMax Code 凭证：读本机客户端登录态 + access token 生命周期。
 *
 * ## 客户端登录态（明文 JSON，比 Qoder 简单）
 *   %USERPROFILE%/.minimax/auth/prod/cn/mcode-public/auth.json
 *   { schemaVersion, records: { "<clientKey>": { accessToken, refreshToken, expiresAtMs, … } } }
 *   —— `records` 只有一个条目（当前登录账号）。**明文**，无需解密。
 *
 * ## ⚠️ 凭证互斥（本工具最大的坑，比 Qoder 严重）
 * MiniMax 的 refresh token 是**一次性**的：刷新成功后旧 token 立刻作废。
 * 且**同一账号同时只有一个有效会话** —— 本工具与官方客户端同时用一个账号会**互相踢下线**。
 * ⇒ 强烈建议给本工具配**专用账号**（与日常客户端分开）。
 *
 * ## token 生命周期
 *   · access token（`mmoat_`）寿命短（约 1–4 小时），过期前 2 分钟自动刷新；
 *   · refresh token（`mmort_`）刷新后会被上游**轮换**，必须写回本地（否则下次刷新失败）。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { CredentialError, UpstreamError } from './errors.js';
const MINIMAX_TOKEN_ENDPOINT = 'https://account.minimax.cn/oauth2/token';
/** 提前刷新余量：过期前 120s 内的 token 视为不可用（时钟偏差 + 请求耗时）。 */
const REFRESH_MARGIN_MS = 120_000;
/** MiniMax Code 客户端公开的 OAuth 客户端参数（与桌面端同源）。 */
const OAUTH_FORM = {
    client_id: 'mcode-public',
    scope: 'agent.default',
    audience: 'agent-backend',
};
/** 客户端登录态文件（可用 MINIMAX_AUTH_FILE 覆盖）。 */
export function clientAuthFile() {
    const override = (process.env.MINIMAX_AUTH_FILE ?? '').trim();
    if (override)
        return override;
    const home = process.env.USERPROFILE ?? homedir();
    return join(home, '.minimax', 'auth', 'prod', 'cn', 'mcode-public', 'auth.json');
}
/** 本工具自己的凭证落盘位置（`~/.waygate/mmcode/credential.json`）。 */
export function credentialPath() {
    return join(commandDir('mmcode'), 'credential.json');
}
/** 从客户端 auth.json 读出第一条记录（当前登录账号）。 */
export function readClientCredential() {
    const file = clientAuthFile();
    if (!existsSync(file)) {
        throw new CredentialError(`找不到客户端登录态 ${file} —— 请先在 MiniMax Code 客户端登录；或用 MINIMAX_AUTH_FILE 指定文件`);
    }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (err) {
        throw new CredentialError(`客户端登录态不是合法 JSON：${err.message}`);
    }
    const records = parsed.records ?? {};
    const keys = Object.keys(records);
    if (keys.length === 0) {
        throw new CredentialError('客户端当前未登录（auth.json 无记录）—— 请在客户端登录后重试');
    }
    const rec = records[keys[0]];
    const accessToken = typeof rec.accessToken === 'string' ? rec.accessToken : '';
    const refreshToken = typeof rec.refreshToken === 'string' ? rec.refreshToken : '';
    if (!accessToken || !refreshToken) {
        throw new CredentialError('登录态缺少 accessToken 或 refreshToken —— 客户端未登录？请在客户端登录后重试');
    }
    return {
        accessToken,
        refreshToken,
        expiresAt: typeof rec.expiresAtMs === 'number' ? rec.expiresAtMs : 0,
        account: typeof rec.loginEpoch === 'string' ? rec.loginEpoch.slice(0, 8) : undefined,
    };
}
/** 读本工具已落盘的凭证（无则 null）。 */
export function readSavedCredential() {
    const file = credentialPath();
    if (!existsSync(file))
        return null;
    try {
        const c = JSON.parse(readFileSync(file, 'utf8'));
        return c.accessToken && c.refreshToken ? c : null;
    }
    catch {
        return null;
    }
}
/** 落盘（0600）。refresh token 轮换后也要调用本函数写回。 */
export function saveCredential(cred) {
    const path = credentialPath();
    writeFileSync(path, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* Windows 语义有限 */
    }
    return path;
}
/**
 * token 管理器：缓存 access token，过期前自动刷新（并发去重），轮换时写回。
 *
 * 与 relay 里那个 Nest 服务同语义，但去掉了框架依赖 —— 核心就是「到期就换、换完写回」。
 */
export class MinimaxTokenManager {
    onLog;
    cached = null;
    inFlight = null;
    constructor(onLog = () => { }) {
        this.onLog = onLog;
    }
    /** 取可用 access token（必要时刷新并写回）。 */
    async accessToken() {
        const cred = this.cached ?? readSavedCredential() ?? readClientCredential();
        this.cached = cred;
        if (Date.now() + REFRESH_MARGIN_MS < cred.expiresAt)
            return cred.accessToken;
        if (this.inFlight)
            return this.inFlight;
        const job = this.refresh(cred).finally(() => {
            this.inFlight = null;
        });
        this.inFlight = job;
        return job;
    }
    async refresh(cred) {
        if (!cred.refreshToken.startsWith('mmort_')) {
            throw new CredentialError('凭证不是有效的 MiniMax refresh token（应以 mmort_ 开头）—— 请用 mmcode login 重新导入');
        }
        const form = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: cred.refreshToken,
            ...OAUTH_FORM,
        });
        let res;
        try {
            res = await fetch(MINIMAX_TOKEN_ENDPOINT, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: form.toString(),
                signal: AbortSignal.timeout(20_000),
            });
        }
        catch (err) {
            throw new UpstreamError(`刷新令牌失败（account.minimax.cn 不可达）：${err.message}`);
        }
        if (!res.ok) {
            const raw = await res.text().catch(() => '');
            throw new CredentialError(`刷新令牌被拒（HTTP ${res.status}）：${raw.slice(0, 200) || '无响应体'}。` +
                `refresh token 可能已失效或已被官方客户端占用 —— 在客户端重新登录后跑 mmcode login。`);
        }
        const grant = (await res.json().catch(() => null));
        if (!grant || typeof grant.access_token !== 'string') {
            throw new CredentialError('令牌刷新响应缺少 access_token');
        }
        const expiresAt = typeof grant.expires_at_ms === 'number' && grant.expires_at_ms > Date.now()
            ? grant.expires_at_ms
            : typeof grant.expires_in === 'number' && grant.expires_in > 0
                ? Date.now() + (grant.expires_in > 100_000 ? grant.expires_in : grant.expires_in * 1000)
                : Date.now() + 3_600_000;
        const next = {
            ...cred,
            accessToken: grant.access_token,
            expiresAt,
        };
        /* refresh token 轮换（一次性）—— 必须写回，否则下次刷新用的是已作废的旧值。 */
        if (typeof grant.refresh_token === 'string' && grant.refresh_token.startsWith('mmort_')) {
            next.refreshToken = grant.refresh_token;
        }
        this.cached = next;
        saveCredential(next);
        this.onLog(`令牌已刷新（有效至 ${new Date(expiresAt).toISOString()}）`);
        return next.accessToken;
    }
}

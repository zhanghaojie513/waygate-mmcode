/**
 * MiniMax Code 凭证：**官方 OAuth 设备授权**（`mmcode login`）。
 *
 * ## 为什么走设备授权，而不是读本机客户端登录态
 * 本工具的目标形态是**部署在服务器上**（反代给线上项目用）。服务器上没有、也不该有
 * MiniMax Code 桌面客户端 —— 旧的「读本机 auth.json」路线只能在装客户端的机器上跑，
 * 于是每次令牌失效都要人工去 Windows 机器捞 token 再注入数据库，极其繁琐。
 *
 * MiniMax 官方给 CLI/插件留了**标准 OAuth 2.0 设备授权**（RFC 8628 + PKCE S256），
 * 走它就能在任何一台能开浏览器的机器上自助登录，无需桌面客户端：
 *
 *   POST /oauth2/device/code   → { device_code, user_code, verification_uri(_complete), expires_in, interval }
 *   （浏览器打开 verification_uri_complete 完成授权）
 *   POST /oauth2/token         → grant_type=urn:ietf:params:oauth:grant-type:device_code（轮询取票）
 *   POST /oauth2/token         → grant_type=refresh_token（此后长期续期）
 *
 * ⚠️ PKCE **强制**：`/oauth2/device/code` 缺 `code_challenge` 直接 400
 *    「valid S256 PKCE is required」（实测）。
 *
 * ## 同一套 OAuth client，与官方 CLI 同源
 * `client_id=mcode-public` / `scope=agent.default` / `audience=agent-backend`
 * —— 与官方 `mcode login`、以及本工具此前的刷新链路**完全一致**。
 * 因此换票拿到的 token 形态与旧路径一模一样（`mmoat_` / `mmort_`），**刷新逻辑零改动**。
 *
 * ## ⚠️ 凭证互斥（本工具最大的坑，比 Qoder 严重）
 * MiniMax 的 refresh token 是**一次性**的：刷新成功后旧 token 立刻作废。
 * 且**同一账号同时只有一个有效会话** —— 本工具与官方客户端（桌面端或 `mcode` CLI）
 * 同时用一个账号会**互相踢下线**。
 * ⇒ **必须给本工具配专用账号**：只用它跑 `mmcode login`，此后**永不用该账号登任何官方客户端**。
 *
 * ## token 生命周期
 *   · access token（`mmoat_`）寿命短（约 1–4 小时），过期前 2 分钟自动刷新；
 *   · refresh token（`mmort_`）刷新后会被上游**轮换**，必须写回本地（否则下次刷新失败）。
 */
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { commandDir } from 'waygate-core';
import { CredentialError, UpstreamError } from './errors.js';
const MINIMAX_ACCOUNT_BASE = 'https://account.minimax.cn';
const DEVICE_CODE_ENDPOINT = `${MINIMAX_ACCOUNT_BASE}/oauth2/device/code`;
const MINIMAX_TOKEN_ENDPOINT = `${MINIMAX_ACCOUNT_BASE}/oauth2/token`;
/** 提前刷新余量：过期前 120s 内的 token 视为不可用（时钟偏差 + 请求耗时）。 */
const REFRESH_MARGIN_MS = 120_000;
/** `login` 原地等待授权的时长；超时后保留 state，提示用户改用 `login-poll`。 */
export const LOGIN_WAIT_MS = 120_000;
/** MiniMax Code 公开的 OAuth 客户端参数（与官方 CLI / 桌面端同源）。 */
const OAUTH_FORM = {
    client_id: 'mcode-public',
    scope: 'agent.default',
    audience: 'agent-backend',
};
/** 设备码的 grant_type（RFC 8628）。 */
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** 本工具自己的凭证落盘位置（`~/.waygate/mmcode/credential.json`）。 */
export function credentialPath() {
    return join(commandDir('mmcode'), 'credential.json');
}
/** 未完成登录的暂存（device_code + code_verifier），供 `login-poll` 续跑。 */
export function loginStatePath() {
    return join(commandDir('mmcode'), 'login-state.json');
}
function writePrivate(path, content) {
    writeFileSync(path, content, { mode: 0o600 });
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* Windows 语义有限 */
    }
}
/* ─────────────────────── 设备授权流程 ─────────────────────── */
/** 第 ① 步：申请设备码 + 授权链接（带 S256 PKCE）。 */
export async function startDeviceLogin() {
    /* PKCE：verifier 是随机串，challenge 是它的 SHA-256（base64url 无填充）。 */
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const form = new URLSearchParams({
        ...OAUTH_FORM,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
    });
    let res;
    try {
        res = await fetch(DEVICE_CODE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: AbortSignal.timeout(20_000),
        });
    }
    catch (err) {
        throw new UpstreamError(`申请设备码失败（account.minimax.cn 不可达）：${err.message}`);
    }
    const raw = await res.text().catch(() => '');
    let body;
    try {
        body = raw ? JSON.parse(raw) : {};
    }
    catch {
        throw new UpstreamError(`申请设备码返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`);
    }
    if (!res.ok) {
        const detail = String(body.error_description ?? body.error ?? raw).slice(0, 200);
        throw new UpstreamError(`申请设备码被拒（HTTP ${res.status}）：${detail}`);
    }
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    const userCode = typeof body.user_code === 'string' ? body.user_code : '';
    const uri = typeof body.verification_uri_complete === 'string' && body.verification_uri_complete
        ? body.verification_uri_complete
        : typeof body.verification_uri === 'string'
            ? body.verification_uri
            : '';
    if (!deviceCode || !userCode || !uri) {
        throw new UpstreamError('设备码响应缺少 device_code / user_code / verification_uri');
    }
    const expiresInSec = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300;
    const intervalSec = typeof body.interval === 'number' && body.interval > 0 ? body.interval : 3;
    const state = {
        deviceCode,
        codeVerifier,
        userCode,
        verificationUriComplete: uri,
        expiresAt: Date.now() + expiresInSec * 1000,
        intervalMs: intervalSec * 1000,
    };
    writePrivate(loginStatePath(), JSON.stringify(state, null, 2) + '\n');
    return state;
}
/** 读回未完成的登录会话（无 / 已过期则 null）。 */
export function readLoginState() {
    const p = loginStatePath();
    if (!existsSync(p))
        return null;
    try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        if (!s.deviceCode || !s.codeVerifier || !s.expiresAt)
            return null;
        return s;
    }
    catch {
        return null;
    }
}
function clearLoginState() {
    try {
        if (existsSync(loginStatePath()))
            unlinkSync(loginStatePath());
    }
    catch {
        /* 清理失败不影响登录结果 */
    }
}
/**
 * 打一次 token 端点（设备码 grant）。
 *
 * ⚠️ 未授权时上游返回 **HTTP 400** + `{"error":"authorization_pending"}`（实测），
 * **不是** 200 —— 所以「400 一律当失败」是错的，必须看 `error` 字段判语义。
 * 同时兼容 CLI 里 `200 + status:"pending"` 的另一种表达。
 */
async function pollOnce(state) {
    const form = new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT,
        device_code: state.deviceCode,
        client_id: OAUTH_FORM.client_id,
        code_verifier: state.codeVerifier,
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
        throw new UpstreamError(`轮询取票失败（account.minimax.cn 不可达）：${err.message}`);
    }
    const raw = await res.text().catch(() => '');
    let body = {};
    try {
        body = raw ? JSON.parse(raw) : {};
    }
    catch {
        return { kind: 'error', message: `取票返回非 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}` };
    }
    /* 语义优先看 error / status 字段（HTTP 码会骗人：pending 也是 400）。 */
    const signal = String(body.error ?? body.status ?? '').toLowerCase();
    if (signal === 'authorization_pending' || signal === 'pending')
        return { kind: 'pending' };
    if (signal === 'slow_down')
        return { kind: 'slow_down' };
    if (signal === 'access_denied' || signal === 'denied') {
        return { kind: 'error', message: '你在授权页拒绝了本次授权 —— 重新跑 `mmcode login` 可再试' };
    }
    if (signal === 'expired_token') {
        return { kind: 'error', message: '设备码已过期 —— 重新跑 `mmcode login` 换一个新的' };
    }
    const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
    if (!accessToken) {
        const detail = String(body.error_description ?? body.error ?? raw).slice(0, 200);
        return { kind: 'error', message: `取票失败（HTTP ${res.status}）：${detail || '响应无 access_token'}` };
    }
    const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : '';
    if (!refreshToken) {
        return { kind: 'error', message: '取票成功但上游未返回 refresh_token —— 无法长期续期，请重试' };
    }
    return { kind: 'ok', accessToken, refreshToken, expiresAt: expiresAtFrom(body) };
}
/** 从 token 响应算绝对过期时刻（兼容 expires_at_ms / expires_in 秒或毫秒）。 */
function expiresAtFrom(body) {
    const atMs = typeof body.expires_at_ms === 'number' ? body.expires_at_ms : null;
    if (atMs && atMs > Date.now())
        return atMs;
    const sec = typeof body.expires_in === 'number' ? body.expires_in : null;
    if (sec && sec > 0)
        return Date.now() + sec * 1000;
    /* 拿不到就保守给 1 小时（下次请求前会自动刷新，不会因此失效）。 */
    return Date.now() + 3_600_000;
}
/** 从 access token 的 JWT payload 里取 `sub` 前缀（仅用于展示，不做验签）。 */
function accountFromToken(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3 || !parts[1])
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const sub = typeof payload.sub === 'string' ? payload.sub : '';
        return sub ? sub.slice(0, 8) : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 第 ②③ 步：轮询取票（授权完成后调用）。
 *
 * `timeoutMs` 为原地等待上限：到点仍 pending 就**抛 `PendingLoginError`**（不是失败）——
 * 调用方据此提示用户改用 `login-poll`，此时**state 保留**，用户授权完还能续跑
 * （只要设备码没到期，实测有效期 300s）。
 *
 * `onTick` 每轮失败轮询调一次：让终端能显示「等待中…」，否则用户面对的是最长 2 分钟的
 * **完全静默** —— 分不清是在等、还是已经卡死。
 */
export async function pollDeviceLogin(timeoutMs = LOGIN_WAIT_MS, onTick) {
    const state = readLoginState();
    if (!state) {
        throw new CredentialError('没有待完成的登录 —— 先跑 `mmcode login`');
    }
    const startedAt = Date.now();
    const deadline = Math.min(Date.now() + timeoutMs, state.expiresAt);
    let intervalMs = state.intervalMs;
    while (Date.now() < deadline) {
        const outcome = await pollOnce(state);
        if (outcome.kind === 'ok') {
            const cred = {
                accessToken: outcome.accessToken,
                refreshToken: outcome.refreshToken,
                expiresAt: outcome.expiresAt,
                account: accountFromToken(outcome.accessToken),
            };
            saveCredential(cred);
            clearLoginState();
            return cred;
        }
        if (outcome.kind === 'error')
            throw new CredentialError(outcome.message);
        /* slow_down：上游要求放慢，间隔 +5s（RFC 8628 建议）。 */
        if (outcome.kind === 'slow_down')
            intervalMs += 5000;
        onTick?.({ waitedMs: Date.now() - startedAt, remainingMs: Math.max(0, deadline - Date.now()) });
        await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
    /* 到点仍未授权：区分「我们等够了」与「设备码本身过期了」。 */
    if (Date.now() >= state.expiresAt) {
        clearLoginState();
        throw new CredentialError('设备码已过期（5 分钟）—— 重新跑 `mmcode login`');
    }
    throw new PendingLoginError('尚未完成授权');
}
/** 登录尚未完成（`login` 等待超时的正常待机态，不是错误）。 */
export class PendingLoginError extends Error {
    name = 'PendingLoginError';
    constructor(message) {
        super(message);
    }
}
/* ─────────────────────── 凭证读写 ─────────────────────── */
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
    writePrivate(path, JSON.stringify(cred, null, 2) + '\n');
    return path;
}
/** 供 doctor / 启动输出展示的摘要（**绝不回显令牌**）。 */
export function credentialSummary() {
    const cred = readSavedCredential();
    if (!cred)
        return '未登录（跑 `mmcode login`）';
    const left = cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 60000) : null;
    const who = cred.account ? `账号 ${cred.account}…` : '已登录';
    return left !== null ? `${who}（access 有效约 ${left} 分钟）` : who;
}
/* ─────────────────────── token 生命周期 ─────────────────────── */
/**
 * token 管理器：缓存 access token，过期前自动刷新（并发去重），轮换时写回。
 *
 * 与 relay 里那个 Nest 服务同语义，但去掉了框架依赖 —— 核心就是「到期就换、换完写回」。
 * ⚠️ 刷新参数与设备授权**同一个 OAuth client**，故换票拿到的 token 直接可续。
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
        const cred = this.cached ?? readSavedCredential();
        if (!cred) {
            throw new CredentialError('未登录 —— 先跑 `mmcode login`（浏览器授权一次）');
        }
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
    /** 立即刷新（不看余量）。doctor 体检用。 */
    async forceRefresh() {
        const cred = this.cached ?? readSavedCredential();
        if (!cred) {
            throw new CredentialError('未登录 —— 先跑 `mmcode login`（浏览器授权一次）');
        }
        return this.refresh(cred);
    }
    async refresh(cred) {
        if (!cred.refreshToken.startsWith('mmort_')) {
            throw new CredentialError('凭证不是有效的 MiniMax refresh token（应以 mmort_ 开头）—— 请跑 `mmcode login` 重新登录');
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
                'refresh token 可能已失效，或被该账号的**另一处登录**顶掉了 —— 跑 `mmcode login` 重新授权。');
        }
        const grant = (await res.json().catch(() => null));
        if (!grant || typeof grant.access_token !== 'string') {
            throw new CredentialError('令牌刷新响应缺少 access_token');
        }
        const expiresAt = expiresAtFrom(grant);
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

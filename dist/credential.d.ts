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
 * ## ⚠️ 凭证互斥（本工具最大的坑）
 * MiniMax 的 refresh token 是**一次性**的：刷新成功后旧 token 立刻作废。
 * 且**同一账号同时只有一个有效会话** —— 本工具与官方客户端（桌面端或 `mcode` CLI）
 * 同时用一个账号会**互相踢下线**。
 * ⇒ **必须给本工具配专用账号**：只用它跑 `mmcode login`，此后**永不用该账号登任何官方客户端**。
 * （注：这是 **MiniMax 独有**的约束 —— Qoder 支持多会话并存，别把它推广到别家。）
 *
 * ## token 生命周期
 *   · access token（`mmoat_`）寿命短（约 1–4 小时），过期前 2 分钟自动刷新；
 *   · refresh token（`mmort_`）刷新后会被上游**轮换**，必须写回本地（否则下次刷新失败）。
 */
/** `login` 原地等待授权的时长；超时后保留 state，提示用户改用 `login-poll`。 */
export declare const LOGIN_WAIT_MS = 120000;
/** 本工具自己的凭证落盘位置（`~/.waygate/mmcode/credential.json`）。 */
export declare function credentialPath(): string;
/** 未完成登录的暂存（device_code + code_verifier），供 `login-poll` 续跑。 */
export declare function loginStatePath(): string;
export interface MinimaxCredential {
    accessToken: string;
    refreshToken: string;
    /** access token 过期时刻（epoch ms）。 */
    expiresAt: number;
    /** 账号标识（从 access token 的 JWT `sub` 取前 8 位；仅用于展示）。 */
    account?: string;
}
/** 一次设备授权会话（`login` 建立、`login-poll` 续用）。 */
export interface LoginState {
    deviceCode: string;
    /** PKCE code_verifier —— 取票时必须回传，且**不可丢失**（丢了只能重新 login）。 */
    codeVerifier: string;
    /** 给用户看的短码（形如 `Z2MD-MW5P`）。 */
    userCode: string;
    /** 带 user_code 的授权链接（用户直接打开即可）。 */
    verificationUriComplete: string;
    /** 设备码的绝对过期时刻（epoch ms）—— 超过它 `login-poll` 也救不回来。 */
    expiresAt: number;
    /** 上游建议的轮询间隔（ms）。 */
    intervalMs: number;
}
/** 第 ① 步：申请设备码 + 授权链接（带 S256 PKCE）。 */
export declare function startDeviceLogin(): Promise<LoginState>;
/** 读回未完成的登录会话（无 / 已过期则 null）。 */
export declare function readLoginState(): LoginState | null;
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
export declare function pollDeviceLogin(timeoutMs?: number, onTick?: (info: {
    waitedMs: number;
    remainingMs: number;
}) => void): Promise<MinimaxCredential>;
/** 登录尚未完成（`login` 等待超时的正常待机态，不是错误）。 */
export declare class PendingLoginError extends Error {
    readonly name = "PendingLoginError";
    constructor(message: string);
}
/** 读本工具已落盘的凭证（无则 null）。 */
export declare function readSavedCredential(): MinimaxCredential | null;
/** 落盘（0600）。refresh token 轮换后也要调用本函数写回。 */
export declare function saveCredential(cred: MinimaxCredential): string;
/** 供 doctor / 启动输出展示的摘要（**绝不回显令牌**）。 */
export declare function credentialSummary(): string;
/**
 * token 管理器：缓存 access token，过期前自动刷新（并发去重），轮换时写回。
 *
 * 与 relay 里那个 Nest 服务同语义，但去掉了框架依赖 —— 核心就是「到期就换、换完写回」。
 * ⚠️ 刷新参数与设备授权**同一个 OAuth client**，故换票拿到的 token 直接可续。
 */
export declare class MinimaxTokenManager {
    private readonly onLog;
    private cached;
    private inFlight;
    constructor(onLog?: (line: string) => void);
    /** 取可用 access token（必要时刷新并写回）。 */
    accessToken(): Promise<string>;
    /** 立即刷新（不看余量）。doctor 体检用。 */
    forceRefresh(): Promise<string>;
    private refresh;
}

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
/** 客户端登录态文件（可用 MINIMAX_AUTH_FILE 覆盖）。 */
export declare function clientAuthFile(): string;
/** 本工具自己的凭证落盘位置（`~/.waygate/mmcode/credential.json`）。 */
export declare function credentialPath(): string;
export interface MinimaxCredential {
    accessToken: string;
    refreshToken: string;
    /** access token 过期时刻（epoch ms）。 */
    expiresAt: number;
    /** 账号标识（客户端文件里的 uid/uin，若有；仅用于展示）。 */
    account?: string;
}
/** 从客户端 auth.json 读出第一条记录（当前登录账号）。 */
export declare function readClientCredential(): MinimaxCredential;
/** 读本工具已落盘的凭证（无则 null）。 */
export declare function readSavedCredential(): MinimaxCredential | null;
/** 落盘（0600）。refresh token 轮换后也要调用本函数写回。 */
export declare function saveCredential(cred: MinimaxCredential): string;
/**
 * token 管理器：缓存 access token，过期前自动刷新（并发去重），轮换时写回。
 *
 * 与 relay 里那个 Nest 服务同语义，但去掉了框架依赖 —— 核心就是「到期就换、换完写回」。
 */
export declare class MinimaxTokenManager {
    private readonly onLog;
    private cached;
    private inFlight;
    constructor(onLog?: (line: string) => void);
    /** 取可用 access token（必要时刷新并写回）。 */
    accessToken(): Promise<string>;
    private refresh;
}

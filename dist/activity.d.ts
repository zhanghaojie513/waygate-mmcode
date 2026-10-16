/**
 * MiniMax Code 签到与积分账本（命令：`mmcode checkin` / `mmcode credits`）。
 *
 * ## 端点（自官方客户端逆向 + 生产实测）
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai  —— 签到面板
 *   POST /minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai   —— 领取（body {}）
 *   GET  /minimax-cloud/api/v1/credit/details                           —— 积分账本明细
 *
 * ## 为什么能代签（这是本工具相对其他方案的独特价值）
 * **MiniMax** 的「登录客户端签到」和「反代挂着」是互斥的（客户端登录会踢掉反代）。
 * 但签到接口用的就是**本工具已在维护的 access token** —— 于是不必登客户端，直接代签。
 * （注：Qoder 不互斥、支持多会话并存，实测 2026-10-16 —— 上面的说法仅对 MiniMax 成立。）
 *
 * ## 积分口径（铁律：不编造）
 * 账本是**批次级累计**（每笔发放的 授予/剩余/已消耗 + 到期时间）；上游**不回报单次请求消耗**
 * （实测 usage 里无 credit 字段）。所以 `credits` 只给账户级余额，不做单次估算。
 */
/** 签面板里的一天。 */
export interface SigninDay {
    day_no: number;
    points: number;
    /** 1 = 未到，2 = 可签，3 = 已签。 */
    status: number;
    is_today: boolean;
}
export interface SigninPanel {
    days: SigninDay[];
    /** 今天是否可签。 */
    claimable: boolean;
    /** 连续天数（今天在周期里的 day_no）。 */
    streak: number | null;
    /** 今日应得积分（可签时）。 */
    todayPoints: number | null;
}
export interface SigninResult {
    outcome: 'claimed' | 'already' | 'unavailable' | 'error';
    points: number | null;
    streak: number | null;
    message: string;
}
/** 一笔积分发放。 */
export interface CreditGrant {
    creditType: number;
    granted: number;
    remaining: number;
    consumed: number;
    grantedAt: number;
    expireAt: number;
}
export interface CreditLedger {
    /** 账户累计：授予 / 剩余 / 已消耗（各批次求和，精确到 0.01）。 */
    granted: number;
    remaining: number;
    consumed: number;
    /** 最近一笔到期时刻（epoch ms）；null = 无。 */
    nextExpireAt: number | null;
    grants: CreditGrant[];
}
export declare class MinimaxActivity {
    private readonly token;
    constructor(token: () => Promise<string>);
    /** 打一次签到接口，返回 data 段。 */
    /**
     * 签到接口（status / claim）。
     *
     * ★ 走 `fetchWithRetry`：上游存在**间歇性连接超时**，原来"打一次就完"会让用户
     * 偶发看到 `fetch failed`。重试只针对连接层失败（4xx 不重试，见 core retry.ts 注释）。
     * 签到上游**自带幂等**（重复领返回已签状态），所以对 claim 这个 POST 重试也是安全的。
     */
    private callSignin;
    /** 查签到面板（不领取）。 */
    panel(): Promise<SigninPanel>;
    /**
     * 签到（幂等：上游对重复 claim 会拒，这里先查面板再决定）。
     * 领取成功后返回本次积分与连续天数。
     */
    checkin(): Promise<SigninResult>;
    /**
     * 拉积分账本。
     * 三个金额任一缺失的批次**跳过**（宁可少算也不编）；全批次数不出来就抛错（不返回假 0）。
     */
    credits(): Promise<CreditLedger>;
}
/** 人读渲染：签到结果。 */
export declare function renderCheckin(r: SigninResult): string;
/** 人读渲染：积分账本。 */
export declare function renderCredits(l: CreditLedger): string;

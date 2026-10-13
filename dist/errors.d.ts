/**
 * 上游错误（core 会兜成 502 + OpenAI 形状错误体给客户端）。
 */
export declare class UpstreamError extends Error {
    readonly name = "UpstreamError";
    constructor(message: string);
}
/** 凭证类错误（启动/doctor 用：提示用户跑 login，而不是抛栈）。 */
export declare class CredentialError extends Error {
    readonly name = "CredentialError";
    constructor(message: string);
}

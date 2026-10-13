/**
 * 上游错误（core 会兜成 502 + OpenAI 形状错误体给客户端）。
 */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(message: string) {
    super(message);
  }
}

/** 凭证类错误（启动/doctor 用：提示用户跑 login，而不是抛栈）。 */
export class CredentialError extends Error {
  override readonly name = 'CredentialError';
  constructor(message: string) {
    super(message);
  }
}

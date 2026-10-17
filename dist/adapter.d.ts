/**
 * MiniMax Code 适配器：把「官方 OAuth 设备授权登录取到的凭证」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 与 waygate-qoder / waygate-workbuddy 同构（同一个 core 骨架），差异在于：
 *   · 凭证：走 **官方 OAuth 设备授权**（`mmcode login`），**不读本机客户端、不解密**；
 *     这样服务器（无反代目标机的桌面客户端）也能自助登录，无需人工注入 token；
 *   · 协议：上游是 **Anthropic 兼容**（`/mavis/api/v1/llm/v1/messages`），不是自研签名；
 *   · ⚠️ 有**凭证互斥**问题（见 README），必须给用户明确告警。
 */
import { type Adapter, type ModelEntry } from 'waygate-core';
export declare const DEFAULT_MMCODE_BASE_URL = "https://agent.minimax.cn";
export declare const DEFAULT_MMCODE_CHAT_PATH = "/mavis/api/v1/llm/v1/messages";
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
export declare const MINIMAX_MODELS: ModelEntry[];
/** 清单端点（相对 baseUrl）。与 chat 端点不同前缀 —— 这是当初测错的地方。 */
export declare const MODELS_PATH = "/mavis/api/v1/models";
/**
 * 拉上游真清单。失败 / 结构不符 / 空清单 → 返回 null（调用方回落内置清单）。
 *
 * **不带 access token**：实测该端点无需鉴权（带假 token 反而 401 —— 上游若收到
 * Authorization 会去校验它）。不带即匿名可读，也就不依赖登录态，`mmcode models`
 * 在未登录时同样可用。
 */
export declare function pullMinimaxModels(baseUrl: string): Promise<ModelEntry[] | null>;
export declare function createMmcodeAdapter(opts?: {
    baseUrl?: string;
    chatPath?: string;
}): Adapter;

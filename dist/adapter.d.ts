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
 * MiniMax 模型清单：上游**没有**清单端点（实测 `/mavis/api/v1/llm/v1/models` 恒 503），
 * 故用内置清单（与 relay 的种子一致）。这是「目录 = 接口清单」原则的**唯一例外** ——
 * 上游确实不提供，不编造其他来源，只列已知可用的这几个。
 */
export declare const MINIMAX_MODELS: ModelEntry[];
export declare function createMmcodeAdapter(opts?: {
    baseUrl?: string;
    chatPath?: string;
}): Adapter;

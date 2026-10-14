/**
 * MiniMax Code 适配器：把「本机客户端登录态」变成「本地 Anthropic/OpenAI 兼容反代」。
 *
 * 与 waygate-qoder 同构（同一个 core 骨架），差异只有三处：
 *   · 凭证：读客户端**明文** auth.json（无需解密，比 Qoder 简单）；
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
/** 追加一条 OAuth 行（`~/.waygate/mmcode/oauth.json`），让 token 刷新可独立记录过期时间。 */
export declare function statePath(): string;
export declare function createMmcodeAdapter(opts?: {
    baseUrl?: string;
    chatPath?: string;
}): Adapter;

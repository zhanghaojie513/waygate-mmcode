/**
 * 出站翻译：OpenAI Chat Completions → Anthropic Messages（v0.5.0）。
 *
 * 服务于 anthropic 协议的上游（MiniMax Code 的 mavis 网关）。与入站翻译
 * `../anthropic/translate-request.ts`（Anthropic→OpenAI）互为镜像：字段映射
 * 从那边逐条对照反推，两边的语义必须保持一致。
 *
 * 设计取舍：
 *   · **流式恒开**：与 openai 路径同口径（本服务的管道是流式原生的）；
 *   · max_tokens 必填（Anthropic 契约）：缺省回落 8192；
 *   · tool 消息折叠：OpenAI 的 `role:"tool"` 序列必须并成紧跟其后的 user 消息里的
 *     tool_result 块（Anthropic 契约）；
 *   · 连续同角色消息合并（Anthropic 要求 user/assistant 交替，OpenAI 不要求）；
 *   · 未识别字段静默忽略 —— 与两个入站方向的口径一致。
 */
import type { ChatRequestBody } from '@waygate/core';
/** Anthropic Messages 请求体（出站最小集）。 */
export interface AnthropicOutRequest {
    model: string;
    max_tokens: number;
    stream: true;
    messages: Array<{
        role: 'user' | 'assistant';
        content: unknown;
    }>;
    system?: string;
    temperature?: number;
    top_p?: number;
    tools?: Array<{
        name: string;
        description: string;
        input_schema: unknown;
    }>;
    tool_choice?: {
        type: 'auto' | 'any' | 'none';
    } | {
        type: 'tool';
        name: string;
    };
}
/** 翻译入口。输入是本服务内部的 ChatRequestBody（已过 rewrite 层）。 */
export declare function toAnthropicRequest(body: ChatRequestBody): AnthropicOutRequest;

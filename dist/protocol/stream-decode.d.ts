/**
 * Anthropic SSE → OpenAI SSE 字节流转换器（v0.5.0，出站 anthropic 协议的响应方向）。
 *
 * 形态是 **TransformStream**：吃 mavis 上游的 Anthropic 事件流，吐 OpenAI 形状的
 * `data: {chat.completion.chunk}` 行。这样 `readUpstreamSse`（首字超时/空闲看门狗/
 * 聚合/落库/断流判定）**一行不改**地复用 —— mavis 上游在管道里"看起来"就是 OpenAI
 * 兼容上游。与入站编码器 `../anthropic/stream-events.ts` 互为镜像。
 *
 * 事件映射：
 *   message_start                          → 首 chunk（delta.role；记录 id/model/input usage）
 *   content_block_start{tool_use}          → chunk delta.tool_calls[{index,id,type,name}]
 *   content_block_delta{text_delta}        → chunk delta.content
 *   content_block_delta{thinking_delta}    → chunk delta.reasoning_content
 *   content_block_delta{input_json_delta}  → chunk delta.tool_calls[].function.arguments
 *   message_delta                          → 记录 stop_reason / usage（output 权威累计值）
 *   message_stop                           → 收尾 chunk（finish_reason + usage 全量）+ [DONE]
 *   error                                  → 抛错（流错误 → readUpstreamSse 的失败路径）
 *
 * usage 口径（与 usage-tokens.ts 的权威字段对齐）：
 *   prompt_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   completion_tokens = output_tokens
 *   prompt_tokens_details.cached_tokens = cache_read_input_tokens
 *
 *   ⚠️ [v0.5.10 纠偏] Anthropic 的 `input_tokens` **不含**缓存部分（生产实测：
 *   input=43 而 cache_read=128 —— 43 个 token 的 prompt 读不出 128 个缓存 token）。
 *   此前头注写"input_tokens 是全量，含缓存命中"是错的，照它实现导致
 *   prompt_tokens 被低估、且 cached_tokens > prompt_tokens（缓存命中率 297%）。
 *   三个输入字段相加才是真输入；cached_tokens 只取**读**命中（cache_creation 是写，不算命中）。
 *   ⚠️ 不读顶层 cached_tokens —— 与 usage-tokens.ts 同理由：顶层字段有历史坑。
 *
 * 未收到 message_stop 就断流 → 不补 [DONE] → readUpstreamSse 按断流失败处理（语义正确）。
 */
/**
 * 转换流。收到 `message_stop` 后在收尾 chunk 之后补 `data: [DONE]`；
 * 上游提前断流则不补 —— readUpstreamSse 按断流失败处理。
 */
export declare function anthropicToOpenAiSse(): TransformStream<Uint8Array, Uint8Array>;

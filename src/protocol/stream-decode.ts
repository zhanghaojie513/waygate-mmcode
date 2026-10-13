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

import { UpstreamError } from '../errors.js';

/** Anthropic stop_reason → OpenAI finish_reason（与入站 mapStopReason 互逆）。 */
function mapFinish(stop: string | null | undefined): string | null {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return stop ? 'stop' : null;
  }
}

interface DecoderState {
  id: string;
  model: string;
  created: number;
  finish: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  /** [v0.5.10] 本次**写入**缓存的输入 tokens —— Anthropic 单列，计入 prompt 但不算命中。 */
  cacheCreation: number;
  /** Anthropic content block index → OpenAI tool_calls index（只对 tool_use 块分配）。 */
  toolIndexByBlock: Map<number, number>;
  nextToolIndex: number;
}

/** 真输入 = 非缓存输入 + 缓存写入 + 缓存读取（三者都过 prompt，见头注纠偏）。 */
function totalInput(state: DecoderState): number {
  return state.inputTokens + state.cacheCreation + state.cacheRead;
}

function chunkJson(state: DecoderState, delta: Record<string, unknown>, finish: string | null = null, withUsage = false): string {
  const chunk: Record<string, unknown> = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (withUsage) {
    const prompt = totalInput(state);
    chunk.usage = {
      prompt_tokens: prompt,
      completion_tokens: state.outputTokens,
      total_tokens: prompt + state.outputTokens,
      prompt_tokens_details: { cached_tokens: state.cacheRead },
    };
  }
  return JSON.stringify(chunk);
}

/** 处理单个 Anthropic 事件 JSON，返回应下发的 OpenAI chunk 行（null = 无输出）。 */
function onData(state: DecoderState, ev: Record<string, unknown>): string | null {
  switch (ev.type) {
    case 'message_start': {
      const msg = (ev.message ?? {}) as Record<string, unknown>;
      state.id = typeof msg.id === 'string' ? msg.id : `msg_${state.created}`;
      state.model = typeof msg.model === 'string' ? msg.model : '';
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      state.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      state.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
      state.cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
      state.cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
      return chunkJson(state, { role: 'assistant', content: '' });
    }
    case 'content_block_start': {
      const index = typeof ev.index === 'number' ? ev.index : 0;
      const block = (ev.content_block ?? {}) as Record<string, unknown>;
      if (block.type === 'tool_use') {
        const toolIndex = state.nextToolIndex++;
        state.toolIndexByBlock.set(index, toolIndex);
        return chunkJson(state, {
          tool_calls: [{
            index: toolIndex,
            id: typeof block.id === 'string' ? block.id : '',
            type: 'function',
            function: { name: typeof block.name === 'string' ? block.name : '', arguments: '' },
          }],
        });
      }
      return null; // text/thinking 块首帧无内容，delta 里会带
    }
    case 'content_block_delta': {
      const index = typeof ev.index === 'number' ? ev.index : 0;
      const delta = (ev.delta ?? {}) as Record<string, unknown>;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        return chunkJson(state, { content: delta.text });
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
        return chunkJson(state, { reasoning_content: delta.thinking });
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && delta.partial_json !== '') {
        const toolIndex = state.toolIndexByBlock.get(index) ?? 0;
        return chunkJson(state, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] });
      }
      return null;
    }
    case 'message_delta': {
      const delta = (ev.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === 'string') state.finish = mapFinish(delta.stop_reason);
      const usage = (ev.usage ?? {}) as Record<string, unknown>;
      if (typeof usage.output_tokens === 'number') state.outputTokens = usage.output_tokens;
      if (typeof usage.input_tokens === 'number') state.inputTokens = usage.input_tokens;
      if (typeof usage.cache_read_input_tokens === 'number') state.cacheRead = usage.cache_read_input_tokens;
      if (typeof usage.cache_creation_input_tokens === 'number') state.cacheCreation = usage.cache_creation_input_tokens;
      return null;
    }
    case 'message_stop':
      return chunkJson(state, {}, state.finish ?? 'stop', true);
    case 'error': {
      const err = (ev.error ?? {}) as Record<string, unknown>;
      throw new UpstreamError(`上游（anthropic 协议）流内错误：${String(err.message ?? 'unknown')}`);
    }
    default:
      return null; // ping / content_block_stop / 未知事件：忽略
  }
}

/**
 * 转换流。收到 `message_stop` 后在收尾 chunk 之后补 `data: [DONE]`；
 * 上游提前断流则不补 —— readUpstreamSse 按断流失败处理。
 */
export function anthropicToOpenAiSse(): TransformStream<Uint8Array, Uint8Array> {
  const state: DecoderState = {
    id: '',
    model: '',
    created: Math.floor(Date.now() / 1000),
    finish: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreation: 0,
    toolIndexByBlock: new Map(),
    nextToolIndex: 0,
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawStop = false;

  const handleFrame = (frame: string, enqueue: (s: string) => void): void => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue; // 坏帧跳过（与 openai 路径同口径）
      }
      const chunk = onData(state, ev);
      if (chunk !== null) enqueue(`data: ${chunk}\n\n`);
      if (ev.type === 'message_stop') {
        sawStop = true;
        enqueue('data: [DONE]\n\n');
      }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const emit = (s: string) => controller.enqueue(encoder.encode(s));
      buffer += decoder.decode(chunk, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleFrame(frame, emit);
      }
    },
    flush(controller) {
      /* 尾部残帧（无空行结尾的最后一帧）也处理；未见到 message_stop 不补 DONE。 */
      const tail = buffer + decoder.decode();
      if (tail.trim() !== '') handleFrame(tail, controller ? (s: string) => controller.enqueue(encoder.encode(s)) : () => undefined);
      void sawStop;
    },
  });
}

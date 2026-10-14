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

import type { ChatMessage, ChatRequestBody } from 'waygate-core';

/** Anthropic Messages 请求体（出站最小集）。 */
export interface AnthropicOutRequest {
  model: string;
  max_tokens: number;
  stream: true;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  system?: string;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ name: string; description: string; input_schema: unknown }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
}

interface TextPart { type: 'text'; text: string }
interface ImagePart { type: 'image_url'; image_url: { url: string } }

function isTextPart(p: unknown): p is TextPart {
  return typeof p === 'object' && p !== null && (p as { type?: string }).type === 'text';
}
function isImagePart(p: unknown): p is ImagePart {
  return typeof p === 'object' && p !== null && (p as { type?: string }).type === 'image_url';
}

/** OpenAI 多模态 content parts → Anthropic blocks；纯文本折叠成 string（省 token）。 */
function contentToBlocks(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (isTextPart(part)) blocks.push({ type: 'text', text: part.text });
    else if (isImagePart(part)) {
      const url = part.image_url?.url ?? '';
      const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      } else if (url) {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
    }
    /* 其他 part 类型（audio 等）静默忽略 —— mavis 当前不接受 */
  }
  const onlyText = blocks.every((b) => b.type === 'text');
  if (onlyText) return blocks.map((b) => String((b as { text: string }).text)).join('');
  return blocks;
}

/** assistant 消息：content → text 块；tool_calls → tool_use 块（arguments JSON 解回对象）。 */
function assistantToBlocks(msg: Record<string, unknown>): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const content = msg.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(isTextPart).map((p) => p.text).join('')
    : '';
  if (text) blocks.push({ type: 'text', text });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const call of calls) {
    if (typeof call !== 'object' || call === null) continue;
    const fn = (call as { function?: { name?: string; arguments?: string } }).function ?? {};
    let input: unknown = {};
    try {
      input = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      input = {}; /* 坏 JSON 不传上游 —— Anthropic 会整请求 400 */
    }
    blocks.push({
      type: 'tool_use',
      id: typeof (call as { id?: string }).id === 'string' ? (call as { id: string }).id : '',
      name: typeof fn.name === 'string' ? fn.name : '',
      input,
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

/**
 * 消息序列转换（核心难点在 tool 消息的归位）：
 * OpenAI 的 `role:"tool"`（带 tool_call_id）必须紧跟 assistant(tool_calls) 之后出现；
 * Anthropic 要求它们变成**下一条 user 消息**里的 tool_result 块。这里把连续的
 * tool 消息攒成一批，遇到下一个非 tool 消息时先产出一条只含 tool_result 的 user
 * 消息（若无后续消息则单独产出）——与入站翻译的拆分逻辑严格互逆。
 * system/developer 消息抽出为顶层 system 文本。
 */
function convertMessages(messages: ChatMessage[]): { messages: AnthropicOutRequest['messages']; system: string } {
  const systemTexts: string[] = [];
  const out: AnthropicOutRequest['messages'] = [];
  let pendingToolResults: Array<Record<string, unknown>> = [];

  const flushTools = () => {
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = (msg as { role?: string }).role;
    const raw = msg as Record<string, unknown>;
    if (role === 'system' || role === 'developer') {
      const t = typeof raw.content === 'string' ? raw.content
        : Array.isArray(raw.content) ? raw.content.filter(isTextPart).map((p) => p.text).join('') : '';
      if (t) systemTexts.push(t);
      continue;
    }
    if (role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '',
        content: typeof raw.content === 'string' ? raw.content
          : Array.isArray(raw.content) ? raw.content.filter(isTextPart).map((p) => p.text).join('') : '',
      });
      continue;
    }
    flushTools();
    if (role === 'assistant') {
      out.push({ role: 'assistant', content: assistantToBlocks(raw) });
    } else {
      out.push({ role: 'user', content: contentToBlocks(raw.content) });
    }
  }
  flushTools();

  /* 合并连续同角色（Anthropic 要求交替；OpenAI 常见 system 后连续 user）。
     合并只发生在边界处，块内容原样拼接 —— 语义无损。 */
  const merged: AnthropicOutRequest['messages'] = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === 'string' && typeof m.content === 'string') {
      prev.content = `${prev.content}\n${m.content}`;
    } else if (
      prev && prev.role === m.role && Array.isArray(prev.content) && Array.isArray(m.content)
    ) {
      prev.content = [...(prev.content as unknown[]), ...(m.content as unknown[])] as unknown;
    } else if (prev && prev.role === m.role) {
      /* 一个 string 一个 blocks：拍平成 blocks 再拼 */
      const a = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content;
      const b = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      prev.content = [...(a as unknown[]), ...(b as unknown[])];
    } else {
      merged.push({ ...m });
    }
  }

  /* 首条必须是 user：若首条是 assistant（罕见），垫一条空 user。 */
  const first = merged[0];
  if (first && first.role !== 'user') {
    merged.unshift({ role: 'user', content: '' });
  }
  return { messages: merged, system: systemTexts.join('\n') };
}

/** OpenAI tool_choice → Anthropic。兼容字符串函数名（WorkBuddy 方言）。 */
function convertToolChoice(choice: unknown): AnthropicOutRequest['tool_choice'] | undefined {
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none') return { type: choice };
    if (choice === 'required') return { type: 'any' };
    return { type: 'tool', name: choice }; // 裸函数名（方言）：按指定工具
  }
  if (typeof choice === 'object') {
    const obj = choice as { type?: string; function?: { name?: string } };
    if (obj.type === 'function' && obj.function?.name) return { type: 'tool', name: obj.function.name };
    if (obj.type === 'auto' || obj.type === 'any' || obj.type === 'none') return { type: obj.type };
  }
  return undefined;
}

/** 翻译入口。输入是本服务内部的 ChatRequestBody（已过 rewrite 层）。 */
export function toAnthropicRequest(body: ChatRequestBody): AnthropicOutRequest {
  const { messages, system } = convertMessages(body.messages ?? []);

  const out: AnthropicOutRequest = {
    model: body.model,
    max_tokens: typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens) && body.max_tokens > 0
      ? body.max_tokens
      : 8192,
    stream: true,
    messages,
  };
  if (system) out.system = system;
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) out.temperature = body.temperature;
  if (typeof body.top_p === 'number' && Number.isFinite(body.top_p)) out.top_p = body.top_p;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const converted = tools
    .filter((t): t is { type: string; function?: { name?: string; description?: string; parameters?: unknown } } =>
      typeof t === 'object' && t !== null && (t as { type?: string }).type === 'function')
    .map((t) => ({
      name: t.function?.name ?? '',
      description: t.function?.description ?? '',
      input_schema: t.function?.parameters ?? { type: 'object', properties: {} },
    }))
    .filter((t) => t.name !== '');
  if (converted.length > 0) out.tools = converted;

  const choice = convertToolChoice(body.tool_choice);
  if (choice) out.tool_choice = choice;
  return out;
}

/**
 * 出站 anthropic 转换器的单测（v0.5.0）：
 *   ① toAnthropicRequest —— OpenAI ChatRequestBody → Anthropic Messages（含 tool 归位、
 *      同角色合并、system 抽取、tool_choice 映射）；
 *   ② anthropicToOpenAiSse —— mavis 的 Anthropic 事件流 → OpenAI SSE 字节流
 *      （喂给 readUpstreamSse 的形态；usage/缓存/finish 映射是落库口径，错一个字段就是错账）。
 */

import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { toAnthropicRequest } from './translate.js';
import { anthropicToOpenAiSse } from './stream-decode.js';
import type { ChatRequestBody } from 'waygate-core';

/** 跑一个 TransformStream：喂字节，收字节，按行解析成对象数组（[DONE] 保留为字符串）。 */
async function runStream(frames: string[]): Promise<Array<string | Record<string, unknown>>> {
  const chunks = frames.map((s) => new TextEncoder().encode(s));
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const out: Array<string | Record<string, unknown>> = [];
  const reader = body.pipeThrough(anthropicToOpenAiSse()).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, sep).trim();
      buf = buf.slice(sep + 2);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') out.push('[DONE]');
      else out.push(JSON.parse(payload) as Record<string, unknown>);
    }
  }
  return out;
}

describe('toAnthropicRequest', () => {
  it('system 抽到顶层；max_tokens 缺省 8192；stream 恒 true', () => {
    const out = toAnthropicRequest({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    } as ChatRequestBody);
    expect(out.system).toBe('be brief');
    expect(out.max_tokens).toBe(8192);
    expect(out.stream).toBe(true);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('★ tool 消息归位：role:"tool" 并成其后 user 消息里的 tool_result 块（与后续文本合并为一条）', () => {
    const out = toAnthropicRequest({
      model: 'MiniMax-M3',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'run', arguments: '{"cmd":"ls"}' } }],
        },
        { role: 'tool', tool_call_id: 'tu_1', content: 'file-a\nfile-b' },
        { role: 'user', content: 'nice' },
      ],
    } as unknown as ChatRequestBody);
    /* tool_result 与其后的用户文本合并成一条 user（Anthropic 要求角色交替；
       tool_result 块在前、文本在后是规范顺序）。 */
    expect(out.messages).toEqual([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'run', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'file-a\nfile-b' },
          { type: 'text', text: 'nice' },
        ],
      },
    ]);
  });

  it('连续同角色合并（Anthropic 要求交替）；多段 system 拼接', () => {
    const out = toAnthropicRequest({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: 'one' },
        { role: 'system', content: 'two' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ],
    } as ChatRequestBody);
    expect(out.system).toBe('one\ntwo');
    expect(out.messages).toEqual([{ role: 'user', content: 'a\nb' }]);
  });

  it('tools / tool_choice 映射（含 WorkBuddy 方言的裸函数名字符串）', () => {
    const out = toAnthropicRequest({
      model: 'MiniMax-M3',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } },
        },
      ],
      tool_choice: 'get_weather',
    } as unknown as ChatRequestBody);
    expect(out.tools).toEqual([
      { name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(out.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
  });

  it('多模态 content：data: URI → base64 块；连续 user 的 blocks+文本合并为一条 blocks', () => {
    const out = toAnthropicRequest({
      model: 'MiniMax-M3',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '只文字' }] },
      ],
    } as unknown as ChatRequestBody);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0]!.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
      { type: 'text', text: '只文字' },
    ]);
  });
});

describe('anthropicToOpenAiSse', () => {
  const MSG_START =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","model":"MiniMax-M3","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":128}}}\n\n';
  const TEXT_DELTA = (t: string) =>
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${t}"}}\n\n`;
  const THINK_DELTA = (t: string) =>
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"${t}"}}\n\n`;
  const TOOL_START =
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_9","name":"run","input":{}}}\n\n';
  const TOOL_ARGS = (json: string) =>
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: json } })}\n\n`;
  const MSG_DELTA =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n';
  const MSG_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

  const isChunk = (x: string | Record<string, unknown>): x is Record<string, unknown> => typeof x === 'object';

  it('完整文本流：role 帧 → 内容帧 → 收尾帧（finish + usage）+ [DONE]', async () => {
    const out = await runStream([MSG_START, TEXT_DELTA('你'), TEXT_DELTA('好'), MSG_DELTA, MSG_STOP]);
    const chunks = out.filter(isChunk);
    expect(chunks.length).toBe(4); // role + 2 content + finish
    expect(out[out.length - 1]).toBe('[DONE]');
    expect((chunks[0]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect((chunks[1]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({ content: '你' });
    const fin = chunks[3]!;
    expect((fin.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe('stop');
    /* usage 口径 [v0.5.10]：prompt = input(10) + cache_creation(0) + cache_read(128) = 138 ——
       Anthropic 的 input_tokens **不含**缓存部分（生产实测 input=43/cache_read=128 即此形态），
       三者相加才是真输入；cached_tokens 只取**读**命中。旧断言 prompt=10 是漏掉缓存的低估值。 */
    expect(fin.usage).toEqual({
      prompt_tokens: 138,
      completion_tokens: 7,
      total_tokens: 145,
      prompt_tokens_details: { cached_tokens: 128 },
    });
  });

  it('★ prompt 恒 ≥ cached（生产曾出现 input=43/cache_read=128 → 命中率 297% 的低估形态）', async () => {
    const out = await runStream([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","role":"assistant","model":"MiniMax-M3","usage":{"input_tokens":43,"output_tokens":5,"cache_read_input_tokens":128,"cache_creation_input_tokens":64}}}\n\n',
      MSG_STOP,
    ]);
    const fin = (out.filter(isChunk).at(-1) as Record<string, unknown>).usage as {
      prompt_tokens: number;
      total_tokens: number;
      prompt_tokens_details: { cached_tokens: number };
    };
    expect(fin.prompt_tokens).toBe(43 + 64 + 128); // 235：三路输入相加
    expect(fin.prompt_tokens).toBeGreaterThanOrEqual(fin.prompt_tokens_details.cached_tokens);
    expect(fin.total_tokens).toBe(235 + 5); // prompt 235 + output 5（message_start 带的初值）
  });

  it('thinking → reasoning_content；tool_use → tool_calls（含分段 arguments）', async () => {
    const out = await runStream([
      MSG_START,
      THINK_DELTA('想'),
      TOOL_START,
      TOOL_ARGS('{"a"'),
      TOOL_ARGS(':1}'),
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
      MSG_STOP,
    ]);
    const chunks = out.filter(isChunk);
    expect((chunks[1]!.choices as Array<Record<string, unknown>>)[0]!.delta).toEqual({ reasoning_content: '想' });
    const toolStart = (chunks[2]!.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>;
    expect(toolStart.tool_calls).toEqual([
      { index: 0, id: 'tu_9', type: 'function', function: { name: 'run', arguments: '' } },
    ]);
    const a1 = ((chunks[3]!.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    const a2 = ((chunks[4]!.choices as Array<Record<string, unknown>>)[0]!.delta as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>;
    expect((a1[0]!.function as Record<string, string>).arguments).toBe('{"a"');
    expect((a2[0]!.function as Record<string, string>).arguments).toBe(':1}');
    const fin = chunks[5]!;
    expect((fin.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe('tool_calls');
  });

  it('★ 断流（无 message_stop）不补 [DONE] —— readUpstreamSse 按断流失败处理', async () => {
    const out = await runStream([MSG_START, TEXT_DELTA('半截')]);
    expect(out[out.length - 1]).not.toBe('[DONE]');
  });

  it('stop_reason 映射：max_tokens → length', async () => {
    const out = await runStream([
      MSG_START,
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}\n\n',
      MSG_STOP,
    ]);
    const chunks = out.filter(isChunk);
    expect((chunks[1]!.choices as Array<Record<string, unknown>>)[0]!.finish_reason).toBe('length');
  });
});

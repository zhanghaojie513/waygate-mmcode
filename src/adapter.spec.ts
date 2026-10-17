/**
 * 模型清单测试（v0.3.5：改真拉取）。
 *
 * 守两件事：
 *   ① 真拉取 `/mavis/api/v1/models` 能解析上游形状（`providers[].config.models`）；
 *   ② 任何失败形态（网络错 / 非 2xx / 结构与预期不符 / 空清单）都**回落内置清单**
 *      —— 清单是启动路径，绝不能因为上游抖动而让 `mmcode models` 空输出。
 *
 * 用假 fetch，不触碰真实上游。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINIMAX_MODELS, MODELS_PATH, pullMinimaxModels } from './adapter.js';

const BASE = 'https://agent.minimax.cn';

/** 上游真实形状（2026-10-17 实测，已裁剪到我们读的字段）。 */
const upstreamBody = {
  version: 'x',
  ttlSeconds: 60,
  providers: [
    {
      providerId: 'minimax',
      config: {
        models: {
          'MiniMax-M2.7': { name: 'M2.7', reasoning: true, limit: { context: 200000, output: 128000 } },
          'MiniMax-M3': { name: 'M3', reasoning: true, limit: { context: 512000, output: 128000 } },
        },
      },
    },
  ],
};

function stubJson(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('pullMinimaxModels：真拉取', () => {
  it('★ 解析上游形状 → id + displayName（短名前补 MiniMax 前缀）', async () => {
    stubJson(upstreamBody);
    const models = await pullMinimaxModels(BASE);
    expect(models).toEqual([
      { id: 'MiniMax-M2.7', displayName: 'MiniMax M2.7' },
      { id: 'MiniMax-M3', displayName: 'MiniMax M3' },
    ]);
  });

  it('★ 打的是 /mavis/api/v1/models（不是先前测错的 /llm/v1/models）', async () => {
    stubJson(upstreamBody);
    await pullMinimaxModels(BASE);
    const url = (vi.mocked(fetch).mock.calls[0]![0] as unknown) as string;
    expect(url).toBe(`${BASE}${MODELS_PATH}`);
    expect(MODELS_PATH).toBe('/mavis/api/v1/models');
    expect(url).not.toContain('/llm/v1/models');
  });

  it('★ 不带 Authorization（该端点匿名可读；带假 token 上游反而 401）', async () => {
    stubJson(upstreamBody);
    await pullMinimaxModels(BASE);
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit | undefined;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('baseUrl 末尾带斜杠不产生双斜杠', async () => {
    stubJson(upstreamBody);
    await pullMinimaxModels(`${BASE}/`);
    const url = (vi.mocked(fetch).mock.calls[0]![0] as unknown) as string;
    expect(url).toBe(`${BASE}${MODELS_PATH}`);
  });
});

describe('pullMinimaxModels：失败一律回落 null（调用方用内置清单）', () => {
  it('网络不可达（fetch 抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });

  it('非 2xx', async () => {
    stubJson({}, 503);
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });

  it('响应里没有 providers', async () => {
    stubJson({ version: 'x' });
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });

  it('providers 里没有 providerId=minimax', async () => {
    stubJson({ providers: [{ providerId: 'other', config: { models: { X: { name: 'X' } } } }] });
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });

  it('models 为空对象（不能让清单变空）', async () => {
    stubJson({ providers: [{ providerId: 'minimax', config: { models: {} } }] });
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });

  it('坏 JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    expect(await pullMinimaxModels(BASE)).toBeNull();
  });
});

describe('内置清单（回落基线）', () => {
  it('4 个模型，id 与上游当前一致', () => {
    expect(MINIMAX_MODELS.map((m) => m.id).sort()).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash-Preview',
    ]);
  });

  it('每个都有 displayName（客户端里要能辨认）', () => {
    for (const m of MINIMAX_MODELS) expect(m.displayName).toBeTruthy();
  });
});

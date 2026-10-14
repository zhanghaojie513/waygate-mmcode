/**
 * 签到与积分账本测试（用假 fetch，不触碰真实上游）。
 * 重点守：业务码闸、金额缺失跳过（不编造）、批次求和口径、签到幂等判定。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinimaxActivity, renderCheckin, renderCredits } from './activity.js';

function stub(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
}

const ok = (data: unknown) => ({ base_resp: { status_code: 0 }, data });

afterEach(() => vi.unstubAllGlobals());

describe('MinimaxActivity.checkin', () => {
  it('可签 → claim → 返回积分与连续天数', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      call += 1;
      const isClaim = String(url).includes('/claim');
      return new Response(JSON.stringify(isClaim
        ? ok({ claim_result: 1, day_no: 4, points: 1000 })
        : ok({ days: [{ day_no: 3, points: 400, status: 3, is_today: false }, { day_no: 4, points: 1000, status: 2, is_today: true }] })), { status: 200 });
    }));
    const r = await new MinimaxActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('claimed');
    expect(r.points).toBe(1000);
    expect(r.streak).toBe(4);
    expect(call).toBe(2); // 先查面板、再领取
  });

  it('今天已签（status=3）→ already，且不再打 claim', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify(ok({ days: [{ day_no: 3, points: 400, status: 3, is_today: true }] })), { status: 200 });
    }));
    const r = await new MinimaxActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('already');
    expect(r.streak).toBe(3);
    expect(calls).toBe(1); // 只查了面板
  });

  it('业务码非 0 → error 带上游 msg', async () => {
    stub({ base_resp: { status_code: 1406010011, status_msg: 'invalid timezone_id' } });
    const r = await new MinimaxActivity(async () => 'tok').checkin();
    expect(r.outcome).toBe('error');
    expect(r.message).toContain('invalid timezone_id');
  });
});

describe('MinimaxActivity.credits', () => {
  it('多批次求和（精确到 0.01）', async () => {
    stub({ base_resp: { status_code: 0 }, details: [
      { credit_type: 2, granted_amount: 800, remaining_amount: 188.65, consumed_amount: 611.35, granted_at_ms: 1, expire_at_ms: Date.now() + 86400000 },
      { credit_type: 2, granted_amount: 400, remaining_amount: 400, consumed_amount: 0, granted_at_ms: 2, expire_at_ms: Date.now() + 172800000 },
    ] });
    const l = await new MinimaxActivity(async () => 'tok').credits();
    expect(l.granted).toBe(1200);
    expect(l.remaining).toBe(588.65);
    expect(l.consumed).toBe(611.35);
    expect(l.grants).toHaveLength(2);
    expect(l.nextExpireAt).toBeGreaterThan(Date.now());
  });

  it('金额缺失的批次被跳过（不编造）', async () => {
    stub({ base_resp: { status_code: 0 }, details: [
      { granted_amount: 800, remaining_amount: 100, consumed_amount: 700 },   // 完整
      { granted_amount: 400, remaining_amount: null, consumed_amount: 0 },    // 缺一 → 跳过
      { granted_amount: 'abc' },                                              // 非数字 → 跳过
    ] });
    const l = await new MinimaxActivity(async () => 'tok').credits();
    expect(l.grants).toHaveLength(1);
    expect(l.granted).toBe(800);
  });

  it('全部批次都认不出 → 抛错（不返回假 0）', async () => {
    stub({ base_resp: { status_code: 0 }, details: [{ foo: 1 }, { bar: 2 }] });
    await expect(new MinimaxActivity(async () => 'tok').credits()).rejects.toThrow('没有可识别的积分批次');
  });

  it('details 不是数组 → 抛错', async () => {
    stub({ base_resp: { status_code: 0 }, details: 'nope' });
    await expect(new MinimaxActivity(async () => 'tok').credits()).rejects.toThrow('缺少 details');
  });

  it('HTTP 非 2xx → 抛错带上游状态', async () => {
    stub({}, 500);
    await expect(new MinimaxActivity(async () => 'tok').credits()).rejects.toThrow('HTTP 500');
  });
});

describe('渲染', () => {
  it('renderCheckin 三种结局各有人话', () => {
    expect(renderCheckin({ outcome: 'claimed', points: 100, streak: 2, message: '签到成功 +100 积分（连续第 2 天）' })).toContain('✓');
    expect(renderCheckin({ outcome: 'already', points: null, streak: 3, message: '今天已签到' })).toContain('·');
    expect(renderCheckin({ outcome: 'error', points: null, streak: null, message: '失败' })).toContain('✗');
  });

  it('renderCredits 含三个合计与明细行', () => {
    const text = renderCredits({
      granted: 1200, remaining: 588.65, consumed: 611.35, nextExpireAt: Date.now() + 86400000,
      grants: [{ creditType: 2, granted: 800, remaining: 188.65, consumed: 611.35, grantedAt: 1, expireAt: Date.now() + 86400000 }],
    });
    expect(text).toContain('剩余    588.65');
    expect(text).toContain('批次明细（1 笔）');
    expect(text).toContain('+800');
  });
});

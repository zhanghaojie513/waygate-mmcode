/**
 * MiniMax Code 签到与积分账本（命令：`mmcode checkin` / `mmcode credits`）。
 *
 * ## 端点（自官方客户端逆向 + 生产实测）
 *   GET  /minimax-cloud/api/v1/signin/status?timezone_id=Asia/Shanghai  —— 签到面板
 *   POST /minimax-cloud/api/v1/signin/claim?timezone_id=Asia/Shanghai   —— 领取（body {}）
 *   GET  /minimax-cloud/api/v1/credit/details                           —— 积分账本明细
 *
 * ## 为什么能代签（这是本工具相对其他方案的独特价值）
 * Qoder / MiniMax 的「登录客户端签到」和「反代挂着」是互斥的（客户端登录会踢掉反代）。
 * 但签到接口用的就是**本工具已在维护的 access token** —— 于是不必登客户端，直接代签。
 *
 * ## 积分口径（铁律：不编造）
 * 账本是**批次级累计**（每笔发放的 授予/剩余/已消耗 + 到期时间）；上游**不回报单次请求消耗**
 * （实测 usage 里无 credit 字段）。所以 `credits` 只给账户级余额，不做单次估算。
 */

import { UpstreamError } from './errors.js';

const MINIMAX_API = 'https://agent.minimax.cn/minimax-cloud/api/v1';
/** 签到「今天」的时区边界（与官方客户端一致；缺参数上游报 invalid timezone_id）。 */
const SIGNIN_TZ = 'Asia/Shanghai';
const REQUEST_TIMEOUT_MS = 20_000;

/** 签面板里的一天。 */
export interface SigninDay {
  day_no: number;
  points: number;
  /** 1 = 未到，2 = 可签，3 = 已签。 */
  status: number;
  is_today: boolean;
}

export interface SigninPanel {
  days: SigninDay[];
  /** 今天是否可签。 */
  claimable: boolean;
  /** 连续天数（今天在周期里的 day_no）。 */
  streak: number | null;
  /** 今日应得积分（可签时）。 */
  todayPoints: number | null;
}

export interface SigninResult {
  outcome: 'claimed' | 'already' | 'unavailable' | 'error';
  points: number | null;
  streak: number | null;
  message: string;
}

/** 一笔积分发放。 */
export interface CreditGrant {
  creditType: number;
  granted: number;
  remaining: number;
  consumed: number;
  grantedAt: number;
  expireAt: number;
}

export interface CreditLedger {
  /** 账户累计：授予 / 剩余 / 已消耗（各批次求和，精确到 0.01）。 */
  granted: number;
  remaining: number;
  consumed: number;
  /** 最近一笔到期时刻（epoch ms）；null = 无。 */
  nextExpireAt: number | null;
  grants: CreditGrant[];
}

/** 上游信封里的业务码闸（非 0 抛错，带上游 msg）。 */
function assertOk(body: { base_resp?: { status_code?: number; status_msg?: string } }): void {
  const code = body.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    throw new UpstreamError(body.base_resp?.status_msg ?? `上游业务码 ${code}`);
  }
}

/** 取数字（数字或数字字符串）；取不到 null。 */
function toAmount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class MinimaxActivity {
  constructor(private readonly token: () => Promise<string>) {}

  /** 打一次签到接口，返回 data 段。 */
  private async callSignin(action: 'status' | 'claim'): Promise<Record<string, unknown>> {
    const token = await this.token();
    const url = `${MINIMAX_API}/signin/${action}?timezone_id=${encodeURIComponent(SIGNIN_TZ)}`;
    const res = await fetch(url, {
      method: action === 'claim' ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(action === 'claim' ? { 'content-type': 'application/json' } : {}),
      },
      ...(action === 'claim' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new UpstreamError(`签到接口 HTTP ${res.status}`);
    const body = (await res.json()) as {
      base_resp?: { status_code?: number; status_msg?: string };
      data?: Record<string, unknown>;
    };
    assertOk(body);
    if (!body.data || typeof body.data !== 'object') throw new UpstreamError('签到响应缺少 data 段');
    return body.data;
  }

  /** 查签到面板（不领取）。 */
  async panel(): Promise<SigninPanel> {
    const data = await this.callSignin('status');
    const days = Array.isArray(data.days) ? (data.days as SigninDay[]) : [];
    const today = days.find((d) => d.is_today) ?? null;
    return {
      days,
      claimable: today?.status === 2,
      streak: today?.day_no ?? null,
      todayPoints: today?.status === 2 ? today.points : null,
    };
  }

  /**
   * 签到（幂等：上游对重复 claim 会拒，这里先查面板再决定）。
   * 领取成功后返回本次积分与连续天数。
   */
  async checkin(): Promise<SigninResult> {
    let panel: SigninPanel;
    try {
      panel = await this.panel();
    } catch (err) {
      return { outcome: 'error', points: null, streak: null, message: (err as Error).message };
    }
    if (!panel.claimable) {
      const already = panel.streak !== null;
      return {
        outcome: 'already',
        points: null,
        streak: panel.streak,
        message: already ? `今天已签到（连续第 ${panel.streak} 天）` : '今日不可签到（活动未开始或已结束）',
      };
    }
    try {
      const data = await this.callSignin('claim');
      const points = toAmount(data.points);
      const streak = typeof data.day_no === 'number' ? data.day_no : panel.streak;
      return { outcome: 'claimed', points, streak, message: `签到成功 +${points ?? '?'} 积分（连续第 ${streak ?? '?'} 天）` };
    } catch (err) {
      return { outcome: 'error', points: null, streak: panel.streak, message: (err as Error).message };
    }
  }

  /**
   * 拉积分账本。
   * 三个金额任一缺失的批次**跳过**（宁可少算也不编）；全批次数不出来就抛错（不返回假 0）。
   */
  async credits(): Promise<CreditLedger> {
    const token = await this.token();
    const res = await fetch(`${MINIMAX_API}/credit/details`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new UpstreamError(`账本接口 HTTP ${res.status}`);
    const body = (await res.json()) as {
      base_resp?: { status_code?: number; status_msg?: string };
      details?: unknown;
    };
    assertOk(body);
    if (!Array.isArray(body.details)) throw new UpstreamError('账本响应缺少 details 数组');

    const grants: CreditGrant[] = [];
    for (const raw of body.details) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      const granted = toAmount(d.granted_amount);
      const remaining = toAmount(d.remaining_amount);
      const consumed = toAmount(d.consumed_amount);
      if (granted === null || remaining === null || consumed === null) continue;
      grants.push({
        creditType: typeof d.credit_type === 'number' ? d.credit_type : 0,
        granted,
        remaining,
        consumed,
        grantedAt: typeof d.granted_at_ms === 'number' ? d.granted_at_ms : 0,
        expireAt: typeof d.expire_at_ms === 'number' ? d.expire_at_ms : 0,
      });
    }
    if (grants.length === 0) {
      throw new UpstreamError('账本里没有可识别的积分批次（响应形状变化？）');
    }
    const sum = (pick: (g: CreditGrant) => number): number => round2(grants.reduce((s, g) => s + pick(g), 0));
    const future = grants.filter((g) => g.expireAt > Date.now()).map((g) => g.expireAt);
    return {
      granted: sum((g) => g.granted),
      remaining: sum((g) => g.remaining),
      consumed: sum((g) => g.consumed),
      nextExpireAt: future.length > 0 ? Math.min(...future) : null,
      grants,
    };
  }
}

/** 人读渲染：签到结果。 */
export function renderCheckin(r: SigninResult): string {
  const icon = r.outcome === 'claimed' ? '✓' : r.outcome === 'already' ? '·' : '✗';
  return `${icon} ${r.message}`;
}

/** 人读渲染：积分账本。 */
export function renderCredits(l: CreditLedger): string {
  const lines: string[] = [];
  lines.push('MiniMax Code 积分账本');
  lines.push('');
  lines.push(`剩余    ${l.remaining}`);
  lines.push(`已消耗  ${l.consumed}`);
  lines.push(`累计发放 ${l.granted}`);
  if (l.nextExpireAt) lines.push(`最近到期 ${new Date(l.nextExpireAt).toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`批次明细（${l.grants.length} 笔）：`);
  for (const g of l.grants.slice(0, 10)) {
    const exp = g.expireAt ? new Date(g.expireAt).toISOString().slice(0, 10) : '—';
    lines.push(`  +${g.granted}  剩 ${g.remaining}  用 ${g.consumed}  到期 ${exp}`);
  }
  if (l.grants.length > 10) lines.push(`  …（还有 ${l.grants.length - 10} 笔）`);
  lines.push('');
  lines.push('注：上游不回报单次请求消耗，以上为账户级批次累计（精确到 0.01）。');
  return lines.join('\n');
}

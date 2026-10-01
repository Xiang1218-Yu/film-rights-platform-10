import type { Contract, Project } from './domain.js';
import type { BudgetLine } from './domain.js';

/**
 * 付款暴露模块（Payment Exposure）
 *
 * 把合同 ceiling / committed / paid、里程碑（日期/金额/状态）与项目交付日
 * 接成可追溯的付款暴露视图：未来 30 天现金压力、已开票未付、交付日前缺缓冲的付款。
 *
 * 本文件只包含纯计算与口径定义，不直接读取仓储，便于以固定 asOf 日期做确定性测试。
 */

export type MilestoneStatus = 'open' | 'invoiced' | 'paid';
export type RiskLevel = 'critical' | 'warning';

export type RiskCode =
  | 'OVERDUE_INVOICED'        // 逾期已开票
  | 'MILESTONE_OVER_CEILING'  // 单个节点金额超合同额
  | 'CONTRACT_OVER_CEILING'   // 节点累计超合同额
  | 'COMMITTED_OVER_CEILING'  // 承诺超合同额
  | 'NO_MILESTONE'            // 有承诺却无付款节点
  | 'SCHEDULE_MISMATCH'       // 承诺未排进任何节点
  | 'BUFFER_SHORTFALL_PROJECT';// 交付日前付款缺预算缓冲（项目级）

/** 从风险回到原始节点的追溯坐标 */
export interface RiskTrace {
  projectId: string;
  contractId?: string;
  vendor?: string;
  milestoneIndex?: number;
  milestoneName?: string;
  due?: string;
  timelineDate?: string;
  source: string;
}

export interface PaymentRisk {
  id: string;
  code: RiskCode;
  level: RiskLevel;
  label: string;
  message: string;
  amount: number;
  projectId: string;
  acknowledged?: { at: string; actor: string; comment?: string };
  /** 主坐标 + 该风险覆盖的全部节点（缓冲缺口会关联多个节点），供前端跳回时间线 */
  traces: RiskTrace[];
}

export interface PaymentNode {
  contractId: string;
  vendor: string;
  scope: string;
  milestoneIndex: number;
  name: string;
  due: string;
  amount: number;
  status: MilestoneStatus;
  overdue: boolean;
  invoicedUnpaid: boolean;
  within30d: boolean;
  beforeDelivery: boolean;
  bufferShortfall: boolean;
  riskIds: string[];
}

export interface ContractExposure {
  contractId: string;
  vendor: string;
  scope: string;
  ceiling: number;
  committed: number;
  paid: number;
  milestoneCount: number;
  invoicedTotal: number;                 // 口径：invoiced 节点金额合计
  scheduledTotal: number;                // 口径：全部节点金额合计
  outstandingCommitted: number;          // 口径：max(committed - paid, 0)
  invoicedUnpaid: number;                // 口径：invoicedTotal（invoiced 视为未付）
  unmilestonedCommitted: number;         // 口径：max(committed - scheduledTotal, 0)
  ceilingHeadroom: number;               // 口径：ceiling - max(committed, scheduledTotal)
  riskIds: string[];
  milestones: PaymentNode[];
}

export interface TimelineGroup {
  date: string;
  relativeDay: number;
  isDelivery: boolean;
  nodes: PaymentNode[];
  dayAmount: number;
  dayInvoicedUnpaid: number;
  /** 截至该日（含）累计仍未付的承诺金额；交付日组即“交付日前未付暴露” */
  cumulativeOutstanding: number;
}

export interface ExposureWindow {
  amount: number;
  invoicedUnpaid: number;
  nodeCount: number;
}

export interface PaymentDefinitions {
  commitment: string;
  invoicing: string;
  payment: string;
  exposure: string;
  budgetBuffer: string;
}

/** 承诺 / 开票 / 支付 / 暴露 / 缓冲的明确口径，随接口下发，避免静态报表式的歧义 */
export const EXPOSURE_DEFINITIONS: PaymentDefinitions = {
  commitment:
    '承诺 committed：合同层面已对供应商锁定、无论是否开票都构成义务的金额，取合同顶层 committed，不以里程碑重算。',
  invoicing:
    '开票 invoiced：里程碑状态为 invoiced 的节点金额合计，代表已开票尚未支付的应付；状态为 paid 的节点视为已结清。',
  payment:
    '支付 paid：合同顶层 paid，为已实际付出的现金；里程碑金额用于排期，不累加为实付。',
  exposure:
    '暴露 exposure：承诺未付 = max(committed - paid, 0)；其中已开票未付为紧急暴露，open 节点为未来暴露。',
  budgetBuffer:
    '预算缓冲 buffer = max(planned - forecast, 0)；交付日前（含交付日）未付节点金额超过缓冲的部分即缓冲缺口。',
};

export interface ExposureInput {
  project: Project;
  contracts: Contract[];
  budgetLines: BudgetLine[];
}

export interface PaymentExposure {
  generatedAt: string;
  asOf: string;
  windowDays: number;
  project: { id: string; code: string; title: string; deliveryDate: string; currency: string };
  definitions: PaymentDefinitions;
  totals: {
    ceiling: number;
    committed: number;
    paid: number;
    scheduledTotal: number;
    invoicedTotal: number;
    invoicedUnpaid: number;
    outstandingCommitted: number;
    cashPressure30d: number;
    cashPressure30dInvoiced: number;
    overdueInvoiced: number;
    preDeliveryUnpaid: number;
    preDeliveryNodeCount: number;
    noMilestoneExposure: number;
    budgetPlanned: number;
    budgetForecast: number;
    budgetBuffer: number;
    preDeliveryShortfall: number;
  };
  window: { next30d: ExposureWindow; overdue: ExposureWindow; preDelivery: ExposureWindow };
  contracts: ContractExposure[];
  timeline: TimelineGroup[];
  risks: PaymentRisk[];
}

export class PaymentDataError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentDataError';
    this.code = code;
  }
}

const DAY_MS = 86400000;

function parseDate(value: string, field: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PaymentDataError('INVALID_DATE', `${field} 日期格式非法（应为 YYYY-MM-DD）：${String(value)}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new PaymentDataError('INVALID_DATE', `${field} 不是有效日历日期：${value}`);
  }
  return dt.getTime() / DAY_MS;
}

function assertAmount(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PaymentDataError('INVALID_AMOUNT', `${field} 金额非法（需为非负数）：${String(value)}`);
  }
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

const fmtWan = (n: number) => `${(n / 10000).toFixed(1)}万`;

/**
 * 计算单个项目的付款暴露。asOf 可注入（测试固定时钟）；默认 UTC 今日。
 * 数据口径问题（负金额、坏日期）抛 PaymentDataError，由调用方决定刷新失败语义。
 */
export function buildPaymentExposure(input: ExposureInput, asOf: string = todayUTC()): PaymentExposure {
  const { project, contracts, budgetLines } = input;
  const t0 = parseDate(asOf, 'asOf');
  const delivery = parseDate(project.deliveryDate, 'deliveryDate');
  const horizon = t0 + 30;
  const generatedAt = new Date().toISOString();

  const risks: PaymentRisk[] = [];
  const pushRisk = (risk: PaymentRisk) => {
    risks.push(risk);
    return risk.id;
  };

  const contractViews: ContractExposure[] = [];
  const allNodes: PaymentNode[] = [];
  // 节点级风险先登记，时间线节点再回填 riskIds
  const nodeRiskMap = new Map<string, string[]>();
  const noteNodeRisk = (contractId: string, idx: number, id: string) => {
    const key = `${contractId}:${idx}`;
    const list = nodeRiskMap.get(key) ?? [];
    list.push(id);
    nodeRiskMap.set(key, list);
  };

  for (const c of contracts) {
    assertAmount(c.ceiling, `合同 ${c.id} ceiling`);
    assertAmount(c.committed, `合同 ${c.id} committed`);
    assertAmount(c.paid, `合同 ${c.id} paid`);

    const contractRiskIds: string[] = [];
    const nodes: PaymentNode[] = [];
    let invoicedTotal = 0;
    let scheduledTotal = 0;

    c.milestones.forEach((m, idx) => {
      assertAmount(m.amount, `合同 ${c.id} 节点「${m.name}」amount`);
      const day = parseDate(m.due, `合同 ${c.id} 节点「${m.name}」due`);
      if (m.status === 'invoiced') invoicedTotal += m.amount;
      scheduledTotal += m.amount;

      // 单节点超合同额
      if (m.amount > c.ceiling) {
        const id = `${c.id}:M${idx}:MILESTONE_OVER_CEILING`;
        contractRiskIds.push(id);
        noteNodeRisk(c.id, idx, id);
        pushRisk({
          id, code: 'MILESTONE_OVER_CEILING', level: 'critical', projectId: project.id, amount: m.amount,
          label: '节点超合同额',
          message: `${c.vendor} 节点「${m.name}」金额 ${fmtWan(m.amount)} 超过合同 ceiling ${fmtWan(c.ceiling)}，超额 ${fmtWan(m.amount - c.ceiling)}。`,
          traces: [{ projectId: project.id, contractId: c.id, vendor: c.vendor, milestoneIndex: idx, milestoneName: m.name, due: m.due, timelineDate: m.due, source: 'milestone.amount > contract.ceiling' }],
        });
      }

      nodes.push({
        contractId: c.id, vendor: c.vendor, scope: c.scope, milestoneIndex: idx,
        name: m.name, due: m.due, amount: m.amount, status: m.status,
        overdue: m.status === 'invoiced' && day < t0,
        invoicedUnpaid: m.status === 'invoiced',
        within30d: m.status !== 'paid' && day >= t0 && day <= horizon,
        beforeDelivery: m.status !== 'paid' && day <= delivery,
        bufferShortfall: false, // 待项目缓冲算出后回填
        riskIds: [],
      });
    });

    // 逾期已开票
    nodes.forEach((n, idx) => {
      if (n.overdue) {
        const id = `${c.id}:M${idx}:OVERDUE_INVOICED`;
        contractRiskIds.push(id);
        noteNodeRisk(c.id, idx, id);
        pushRisk({
          id, code: 'OVERDUE_INVOICED', level: 'critical', projectId: project.id, amount: n.amount,
          label: '逾期已开票未付',
          message: `${c.vendor}「${n.name}」已于 ${n.due} 开票 ${fmtWan(n.amount)}，超过基准日仍未支付。`,
          traces: [{ projectId: project.id, contractId: c.id, vendor: c.vendor, milestoneIndex: idx, milestoneName: n.name, due: n.due, timelineDate: n.due, source: 'milestone.status=invoiced && due < asOf' }],
        });
      }
    });

    // 节点累计超合同额
    if (scheduledTotal > c.ceiling) {
      const id = `${c.id}:CONTRACT_OVER_CEILING`;
      contractRiskIds.push(id);
      pushRisk({
        id, code: 'CONTRACT_OVER_CEILING', level: 'critical', projectId: project.id, amount: scheduledTotal - c.ceiling,
        label: '节点累计超合同额',
        message: `${c.vendor} 里程碑合计 ${fmtWan(scheduledTotal)} 超过合同 ceiling ${fmtWan(c.ceiling)}，超出 ${fmtWan(scheduledTotal - c.ceiling)}。`,
        traces: nodes.map((n, i) => ({ projectId: project.id, contractId: c.id, vendor: c.vendor, milestoneIndex: i, milestoneName: n.name, due: n.due, timelineDate: n.due, source: 'sum(milestone.amount) > contract.ceiling' })),
      });
    }

    // 承诺超合同额
    if (c.committed > c.ceiling) {
      const id = `${c.id}:COMMITTED_OVER_CEILING`;
      contractRiskIds.push(id);
      pushRisk({
        id, code: 'COMMITTED_OVER_CEILING', level: 'warning', projectId: project.id, amount: c.committed - c.ceiling,
        label: '承诺超合同额',
        message: `${c.vendor} 承诺 ${fmtWan(c.committed)} 已超过合同 ceiling ${fmtWan(c.ceiling)}，超出 ${fmtWan(c.committed - c.ceiling)}。`,
        traces: [{ projectId: project.id, contractId: c.id, vendor: c.vendor, source: 'contract.committed > contract.ceiling' }],
      });
    }

    // 无节点
    if (c.milestones.length === 0) {
      const exposure = Math.max(c.committed - c.paid, 0);
      const id = `${c.id}:NO_MILESTONE`;
      contractRiskIds.push(id);
      pushRisk({
        id, code: 'NO_MILESTONE', level: 'warning', projectId: project.id, amount: exposure,
        label: '承诺无付款节点',
        message: `${c.vendor} 承诺 ${fmtWan(c.committed)}（未付 ${fmtWan(exposure)}）没有任何里程碑，付款时点不可追溯，交付前须补排节点。`,
        traces: [{ projectId: project.id, contractId: c.id, vendor: c.vendor, source: 'contract.milestones.length === 0' }],
      });
    }

    // 承诺未排进节点（有节点但承诺大于排期合计）
    const unmilestoned = Math.max(c.committed - scheduledTotal, 0);
    if (c.milestones.length > 0 && unmilestoned > 0) {
      const id = `${c.id}:SCHEDULE_MISMATCH`;
      contractRiskIds.push(id);
      pushRisk({
        id, code: 'SCHEDULE_MISMATCH', level: 'warning', projectId: project.id, amount: unmilestoned,
        label: '承诺未排入节点',
        message: `${c.vendor} 承诺 ${fmtWan(c.committed)} 但里程碑仅排 ${fmtWan(scheduledTotal)}，${fmtWan(unmilestoned)} 承诺没有对应付款节点。`,
        traces: [{ projectId: project.id, contractId: c.id, vendor: c.vendor, source: 'committed > sum(milestone.amount)' }],
      });
    }

    nodes.forEach(n => { n.riskIds = nodeRiskMap.get(`${c.id}:${n.milestoneIndex}`) ?? []; });

    const view: ContractExposure = {
      contractId: c.id, vendor: c.vendor, scope: c.scope,
      ceiling: c.ceiling, committed: c.committed, paid: c.paid,
      milestoneCount: c.milestones.length,
      invoicedTotal,
      scheduledTotal,
      outstandingCommitted: Math.max(c.committed - c.paid, 0),
      invoicedUnpaid: invoicedTotal,
      unmilestonedCommitted: unmilestoned,
      ceilingHeadroom: c.ceiling - Math.max(c.committed, scheduledTotal),
      riskIds: contractRiskIds,
      milestones: nodes,
    };
    contractViews.push(view);
    allNodes.push(...nodes);
  }

  // ---- 项目级汇总 ----
  const sum = (sel: (c: Contract) => number) => contracts.reduce((acc, c) => acc + sel(c), 0);
  const lineSum = (sel: (l: BudgetLine) => number) => budgetLines.reduce((acc, l) => acc + sel(l), 0);

  const ceiling = sum(c => c.ceiling);
  const committed = sum(c => c.committed);
  const paid = sum(c => c.paid);
  const invoicedTotal = sum(c => c.milestones.filter(m => m.status === 'invoiced').reduce((a, m) => a + m.amount, 0));
  const scheduledTotal = sum(c => c.milestones.reduce((a, m) => a + m.amount, 0));

  const unpaid = allNodes.filter(n => n.status !== 'paid');
  const inWindow = unpaid.filter(n => n.within30d);
  const overdueNodes = unpaid.filter(n => n.overdue);
  const preDeliveryNodes = unpaid.filter(n => n.beforeDelivery);

  const cashPressure30d = inWindow.reduce((a, n) => a + n.amount, 0);
  const cashPressure30dInvoiced = inWindow.filter(n => n.status === 'invoiced').reduce((a, n) => a + n.amount, 0);
  const overdueInvoiced = overdueNodes.reduce((a, n) => a + n.amount, 0);
  const preDeliveryUnpaid = preDeliveryNodes.reduce((a, n) => a + n.amount, 0);
  const noMilestoneExposure = contracts
    .filter(c => c.milestones.length === 0)
    .reduce((a, c) => a + Math.max(c.committed - c.paid, 0), 0);

  const budgetPlanned = lineSum(l => l.planned);
  const budgetForecast = lineSum(l => l.forecast);
  const budgetBuffer = Math.max(budgetPlanned - budgetForecast, 0);
  const preDeliveryShortfall = Math.max(preDeliveryUnpaid - budgetBuffer, 0);

  // 缓冲缺口：项目级一条风险，关联全部交付日前未付节点（从风险跳回各原节点）
  if (preDeliveryShortfall > 0) {
    const id = `${project.id}:BUFFER_SHORTFALL_PROJECT`;
    preDeliveryNodes.forEach(n => {
      n.bufferShortfall = true;
      n.riskIds = [...n.riskIds, id];
    });
    pushRisk({
      id, code: 'BUFFER_SHORTFALL_PROJECT', level: preDeliveryShortfall > 0 ? 'critical' : 'warning', projectId: project.id,
      amount: preDeliveryShortfall,
      label: '交付日前缺预算缓冲',
      message: `交付日 ${project.deliveryDate} 前需付 ${fmtWan(preDeliveryUnpaid)}，预算缓冲仅 ${fmtWan(budgetBuffer)}，缺口 ${fmtWan(preDeliveryShortfall)}（另 ${fmtWan(noMilestoneExposure)} 无节点承诺未排期）。`,
      traces: preDeliveryNodes.map(n => ({
        projectId: project.id, contractId: n.contractId, vendor: n.vendor, milestoneIndex: n.milestoneIndex,
        milestoneName: n.name, due: n.due, timelineDate: n.due, source: 'preDeliveryUnpaid > max(planned-forecast,0)',
      })),
    });
  }

  // ---- 时间线：按日分组，交付日单独成组（无节点也保留） ----
  const groups = new Map<string, TimelineGroup>();
  const ensure = (date: string, isDelivery: boolean): TimelineGroup => {
    let g = groups.get(date);
    if (!g) {
      g = { date, relativeDay: parseDate(date, 'timeline') - t0, isDelivery, nodes: [], dayAmount: 0, dayInvoicedUnpaid: 0, cumulativeOutstanding: 0 };
      groups.set(date, g);
    }
    if (isDelivery) g.isDelivery = true;
    return g;
  };
  allNodes.forEach(n => {
    const g = ensure(n.due, n.due === project.deliveryDate);
    g.nodes.push(n);
    if (n.status !== 'paid') {
      g.dayAmount += n.amount;
      if (n.status === 'invoiced') g.dayInvoicedUnpaid += n.amount;
    }
  });
  ensure(project.deliveryDate, true);

  const timeline = [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
  let running = 0;
  for (const g of timeline) {
    running += g.nodes.filter(n => n.status !== 'paid').reduce((a, n) => a + n.amount, 0);
    g.cumulativeOutstanding = running;
    g.nodes.sort((a, b) => b.amount - a.amount);
  }

  // 风险排序：critical 优先，其次按首个节点日期
  const rank = (r: PaymentRisk) => (r.level === 'critical' ? 0 : 1);
  risks.sort((a, b) => rank(a) - rank(b) || (a.traces[0]?.due ?? '9999').localeCompare(b.traces[0]?.due ?? '9999') || a.id.localeCompare(b.id));

  return {
    generatedAt, asOf, windowDays: 30,
    project: { id: project.id, code: project.code, title: project.title, deliveryDate: project.deliveryDate, currency: project.currency },
    definitions: EXPOSURE_DEFINITIONS,
    totals: {
      ceiling, committed, paid, scheduledTotal, invoicedTotal,
      invoicedUnpaid: invoicedTotal,
      outstandingCommitted: Math.max(committed - paid, 0),
      cashPressure30d,
      cashPressure30dInvoiced,
      overdueInvoiced,
      preDeliveryUnpaid,
      preDeliveryNodeCount: preDeliveryNodes.length,
      noMilestoneExposure,
      budgetPlanned,
      budgetForecast,
      budgetBuffer,
      preDeliveryShortfall,
    },
    window: {
      next30d: { amount: cashPressure30d, invoicedUnpaid: cashPressure30dInvoiced, nodeCount: inWindow.length },
      overdue: { amount: overdueInvoiced, invoicedUnpaid: overdueInvoiced, nodeCount: overdueNodes.length },
      preDelivery: { amount: preDeliveryUnpaid, invoicedUnpaid: preDeliveryNodes.filter(n => n.status === 'invoiced').reduce((a, n) => a + n.amount, 0), nodeCount: preDeliveryNodes.length },
    },
    contracts: contractViews,
    timeline,
    risks,
  };
}

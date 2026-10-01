import { AuditEvent, Contract, Project, auditEvents, budgetLines, contracts, projects } from './domain.js';

export type MilestoneStatus = 'open' | 'invoiced' | 'paid';
export type RiskKind = 'overdue_invoiced' | 'ceiling_breach' | 'buffer_gap' | 'same_day_cluster' | 'unscheduled_commitment';

export interface PaymentNode { id: string; contractId: string; vendor: string; projectId: string; name: string; due: string; amount: number; status: MilestoneStatus; overdue: boolean; daysUntilDue: number; beforeDelivery: boolean; }
export interface ExposureRisk { id: string; kind: RiskKind; severity: 'critical' | 'warning'; message: string; amount: number; nodeIds: string[]; contractId?: string; acknowledged: boolean; }
export interface TimelineEvent { date: string; overdue: boolean; withinWindow: boolean; nodes: PaymentNode[]; amount: number; cumulative: number; }
export interface ExposureTotals { ceiling: number; committed: number; invoiced: number; paid: number; unpaidCommitted: number; dueWithinWindow: number; overdueInvoiced: number; preDeliveryUnpaid: number; budgetBuffer: number; bufferGap: number; }
export interface PaymentExposure { projectId: string; deliveryDate: string; generatedAt: string; windowDays: number; definitions: Record<string, string>; totals: ExposureTotals; nodes: PaymentNode[]; timeline: TimelineEvent[]; risks: ExposureRisk[]; }

// 口径定义：承诺 / 开票 / 支付 / 暴露 / 预算缓冲
export const EXPOSURE_DEFINITIONS: Record<string, string> = {
  committed: '已承诺 = 合同已签约金额（contract.committed），无论是否开票或到款',
  invoiced: '已开票 = 状态为 invoiced 或 paid 的里程碑金额合计（供应商已开发票）',
  paid: '已支付 = 财务台账口径 contract.paid，可能包含未挂节点的预付款',
  exposure: '付款暴露 = 已承诺未支付（committed − paid），并叠加交付日前付款相对预算缓冲的缺口',
  budgetBuffer: '预算缓冲 = Σ max(0, 预算 planned − 预测 forecast)，即尚未被预测占用的预算余量'
};

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);
const wan = (amount: number) => `¥${(amount / 10000).toFixed(amount % 10000 === 0 ? 0 : 1)}万`;
const dayDiff = (date: string, base: string) => Math.round((Date.parse(date) - Date.parse(base)) / DAY);
const audit = (action: string, entity: string, entityId: string, actor: string, details: string): AuditEvent => { const event: AuditEvent = { id: `AUD-${Date.now()}-${Math.floor(Math.random() * 1000)}`, action, entity, entityId, actor, at: new Date().toISOString(), details }; auditEvents.unshift(event); return event; };

const snapshots = new Map<string, PaymentExposure>();
const acknowledgedRisks = new Map<string, { actor: string; note: string; at: string }>();

export function paymentNodes(projectId: string): PaymentNode[] {
  const project = projects.find(item => item.id === projectId);
  const base = today();
  return contracts.filter(contract => contract.projectId === projectId).flatMap(contract => contract.milestones.map((milestone, index) => ({
    id: `${contract.id}#${index + 1}`, contractId: contract.id, vendor: contract.vendor, projectId,
    name: milestone.name, due: milestone.due, amount: milestone.amount, status: milestone.status,
    overdue: milestone.status !== 'paid' && milestone.due < base,
    daysUntilDue: dayDiff(milestone.due, base),
    beforeDelivery: project ? milestone.due <= project.deliveryDate : false
  })));
}

export function paymentExposure(projectId: string, windowDays = 30): PaymentExposure | undefined {
  const project = projects.find(item => item.id === projectId);
  if (!project) return undefined;
  const base = today();
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const nodes = paymentNodes(projectId);
  const unpaid = nodes.filter(node => node.status !== 'paid');
  const lines = budgetLines.filter(line => line.projectId === projectId);

  const totals: ExposureTotals = {
    ceiling: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0),
    committed: projectContracts.reduce((sum, contract) => sum + contract.committed, 0),
    invoiced: nodes.filter(node => node.status !== 'open').reduce((sum, node) => sum + node.amount, 0),
    paid: projectContracts.reduce((sum, contract) => sum + contract.paid, 0),
    unpaidCommitted: 0, dueWithinWindow: 0, overdueInvoiced: 0, preDeliveryUnpaid: 0, budgetBuffer: 0, bufferGap: 0
  };
  totals.unpaidCommitted = totals.committed - totals.paid;
  totals.overdueInvoiced = unpaid.filter(node => node.status === 'invoiced' && node.overdue).reduce((sum, node) => sum + node.amount, 0);
  totals.dueWithinWindow = unpaid.filter(node => node.daysUntilDue <= windowDays).reduce((sum, node) => sum + node.amount, 0);
  totals.preDeliveryUnpaid = unpaid.filter(node => node.beforeDelivery).reduce((sum, node) => sum + node.amount, 0);
  totals.budgetBuffer = lines.reduce((sum, line) => sum + Math.max(0, line.planned - line.forecast), 0);
  totals.bufferGap = Math.max(0, totals.preDeliveryUnpaid - totals.budgetBuffer);

  const byDate = new Map<string, PaymentNode[]>();
  for (const node of unpaid) byDate.set(node.due, [...(byDate.get(node.due) ?? []), node]);
  let cumulative = 0;
  const timeline: TimelineEvent[] = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dayNodes]) => {
    const amount = dayNodes.reduce((sum, node) => sum + node.amount, 0);
    cumulative += amount;
    return { date, overdue: date < base, withinWindow: dayDiff(date, base) <= windowDays, nodes: dayNodes.sort((a, b) => a.id.localeCompare(b.id)), amount, cumulative };
  });

  const risks: ExposureRisk[] = [];
  for (const contract of projectContracts) {
    const milestoneTotal = contract.milestones.reduce((sum, milestone) => sum + milestone.amount, 0);
    const excess = Math.max(milestoneTotal, contract.committed) - contract.ceiling;
    if (excess > 0) risks.push({ id: `ceiling_breach:${contract.id}`, kind: 'ceiling_breach', severity: contract.committed > contract.ceiling ? 'critical' : 'warning', message: `${contract.vendor} 节点/承诺合计超出合同上限 ${wan(excess)}`, amount: excess, nodeIds: nodes.filter(node => node.contractId === contract.id).map(node => node.id), contractId: contract.id, acknowledged: false });
    if (contract.milestones.length === 0 && contract.committed > contract.paid) risks.push({ id: `unscheduled_commitment:${contract.id}`, kind: 'unscheduled_commitment', severity: 'warning', message: `${contract.vendor} 有 ${wan(contract.committed - contract.paid)} 已承诺未付款，但没有任何付款节点`, amount: contract.committed - contract.paid, nodeIds: [], contractId: contract.id, acknowledged: false });
  }
  for (const node of unpaid.filter(item => item.status === 'invoiced' && item.overdue)) risks.push({ id: `overdue_invoiced:${node.id}`, kind: 'overdue_invoiced', severity: 'critical', message: `${node.vendor}「${node.name}」已开票 ${wan(node.amount)}，逾期 ${-node.daysUntilDue} 天未付`, amount: node.amount, nodeIds: [node.id], contractId: node.contractId, acknowledged: false });
  if (totals.bufferGap > 0) risks.push({ id: `buffer_gap:${projectId}`, kind: 'buffer_gap', severity: 'critical', message: `交付日 ${project.deliveryDate} 前待付 ${wan(totals.preDeliveryUnpaid)}，超出预算缓冲 ${wan(totals.bufferGap)}`, amount: totals.bufferGap, nodeIds: unpaid.filter(node => node.beforeDelivery).map(node => node.id), acknowledged: false });
  for (const event of timeline.filter(item => item.nodes.length > 1)) risks.push({ id: `same_day_cluster:${projectId}:${event.date}`, kind: 'same_day_cluster', severity: 'warning', message: `${event.date} 同日 ${event.nodes.length} 笔付款合计 ${wan(event.amount)}，现金压力集中`, amount: event.amount, nodeIds: event.nodes.map(node => node.id), acknowledged: false });
  for (const risk of risks) risk.acknowledged = acknowledgedRisks.has(risk.id);

  return { projectId, deliveryDate: project.deliveryDate, generatedAt: new Date().toISOString(), windowDays, definitions: EXPOSURE_DEFINITIONS, totals, nodes, timeline, risks };
}

// 从风险 / 节点 ID 回溯到原始合同节点
export function paymentNodeDetail(nodeId: string) {
  const [contractId, indexText] = nodeId.split('#');
  const contract = contracts.find(item => item.id === contractId);
  const index = Number(indexText) - 1;
  if (!contract || !contract.milestones[index]) return undefined;
  const node = paymentNodes(contract.projectId).find(item => item.id === nodeId);
  const exposure = paymentExposure(contract.projectId);
  return { node, milestone: contract.milestones[index], contract, project: projects.find(item => item.id === contract.projectId), risks: exposure?.risks.filter(risk => risk.nodeIds.includes(nodeId)) ?? [] };
}

// 刷新暴露快照：台账不一致（负金额、非法日期、已付超承诺）时刷新失败，保留上一快照并记审计
export function refreshPaymentExposure(projectId: string, actor = '系统') {
  const project = projects.find(item => item.id === projectId);
  if (!project) return undefined;
  const errors: string[] = [];
  for (const contract of contracts.filter(item => item.projectId === projectId)) {
    if (contract.paid > contract.committed) errors.push(`${contract.id} 已支付 ${wan(contract.paid)} 超过已承诺 ${wan(contract.committed)}`);
    contract.milestones.forEach((milestone, index) => {
      if (!(milestone.amount > 0)) errors.push(`${contract.id}#${index + 1} 节点金额非法：${milestone.amount}`);
      if (Number.isNaN(Date.parse(milestone.due))) errors.push(`${contract.id}#${index + 1} 节点日期非法：${milestone.due}`);
    });
  }
  if (errors.length > 0) {
    audit('EXPOSURE_REFRESH_FAILED', 'project', projectId, actor, `付款暴露刷新失败：${errors.join('；')}`);
    return { ok: false as const, errors, snapshot: snapshots.get(projectId) ?? null };
  }
  const exposure = paymentExposure(projectId);
  if (exposure) snapshots.set(projectId, exposure);
  audit('EXPOSURE_REFRESH', 'project', projectId, actor, `付款暴露快照已刷新，窗口 ${exposure?.windowDays ?? 30} 天，风险 ${exposure?.risks.length ?? 0} 项`);
  return { ok: true as const, exposure };
}

// 异常确认：制片主任确认某条风险已知晓，写入审计
export function acknowledgeRisk(projectId: string, riskId: string, actor: string, note = '') {
  const exposure = paymentExposure(projectId);
  const risk = exposure?.risks.find(item => item.id === riskId);
  if (!risk) return undefined;
  acknowledgedRisks.set(riskId, { actor, note, at: new Date().toISOString() });
  risk.acknowledged = true;
  audit('RISK_ACKNOWLEDGED', 'payment-risk', riskId, actor, note || `确认风险 ${risk.kind}：${risk.message}`);
  return risk;
}

// 交付日变更：重算暴露并记审计
export function updateDeliveryDate(projectId: string, newDate: string, actor: string) {
  const project = projects.find(item => item.id === projectId);
  if (!project || Number.isNaN(Date.parse(newDate))) return undefined;
  const previous = project.deliveryDate;
  project.deliveryDate = newDate;
  audit('DELIVERY_DATE_CHANGED', 'project', projectId, actor, `交付日 ${previous} → ${newDate}，付款暴露已重算`);
  return { project, previous, exposure: paymentExposure(projectId) };
}

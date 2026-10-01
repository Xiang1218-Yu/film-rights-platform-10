import { buildPaymentExposure, EXPOSURE_DEFINITIONS, PaymentDataError } from './paymentExposure.js';
import type { PaymentExposure, PaymentRisk } from './paymentExposure.js';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: 'draft' | 'review' | 'approved' | 'locked'; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; projectId?: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '调色初版', due: iso(8), amount: 1100000, status: 'open' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(-4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] },
  { id: 'CTR-04', projectId: 'PRJ-002', vendor: '越界视效', scope: '虚拟拍摄预合成', ceiling: 1000000, committed: 1000000, paid: 0, milestones: [{ name: '预付款', due: iso(10), amount: 1100000, status: 'invoiced' }] },
  { id: 'CTR-05', projectId: 'PRJ-001', vendor: '光影器材', scope: '灯光器材长租（待补排期）', ceiling: 700000, committed: 900000, paid: 300000, milestones: [] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'] },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'] },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'] },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'] }
];
export const approvals: Approval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001', title: 'E01 最终母版锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' }
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals,
    // 付款暴露模块：与原摘要同构下发，口径定义随附；前端可继续只读原字段，保持向后兼容
    paymentExposure: getPaymentExposure(projectId),
    paymentDefinitions: EXPOSURE_DEFINITIONS };
}

export function rightsConflicts(projectId = projects[0].id) {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: { severity: 'critical' | 'warning'; assetA: string; assetB: string; reason: string }[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', assetA: a.name, assetB: b.name, reason: `同一授权标签在重叠窗口内覆盖相同地域：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  return conflicts;
}

export function approve(id: string, status: ApprovalStatus, comment = '') {
  const item = approvals.find(approval => approval.id === id); if (!item) return undefined;
  item.status = status; item.comment = comment; auditEvents.unshift({ id: `AUD-${Date.now()}`, action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor: '当前审批人', at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` }); return item;
}
export function createApproval(input: Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) { const item: Approval = { ...input, id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString() }; approvals.unshift(item); return item; }
export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }

// ---------------------------------------------------------------------------
// 付款暴露：缓存 / 刷新 / 确认审计 / 交付日变更（内存仓储实现，计算口径在 paymentExposure.ts）
// ---------------------------------------------------------------------------

export function todayISO(): string { return new Date().toISOString().slice(0, 10); }

interface ExposureCacheEntry { data: PaymentExposure; refreshedAt: string; }
interface ExposureFailure { at: string; code: string; message: string; }

const exposureCache = new Map<string, ExposureCacheEntry>();
const exposureFailures = new Map<string, ExposureFailure>();
// riskId -> 确认记录；风险按 code+坐标幂等生成，刷新后确认仍能按 id 重新附回
const riskAcknowledgments = new Map<string, { at: string; actor: string; comment?: string }>();

function projectOrThrow(projectId: string) {
  const project = projects.find(p => p.id === projectId);
  if (!project) throw new PaymentDataError('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
  return project;
}

/** 纯重算：不审计、不动缓存，供刷新编排复用（也是“刷新失败保留旧快照”的边界） */
function computeExposure(projectId: string, asOf = todayISO()): PaymentExposure {
  const project = projectOrThrow(projectId);
  const data = buildPaymentExposure({
    project,
    contracts: contracts.filter(c => c.projectId === projectId),
    budgetLines: budgetLines.filter(l => l.projectId === projectId),
  }, asOf);
  return applyAcknowledgments(data);
}

function applyAcknowledgments(data: PaymentExposure): PaymentExposure {
  for (const risk of data.risks) {
    const ack = riskAcknowledgments.get(risk.id);
    if (ack) risk.acknowledged = ack;
  }
  return data;
}

export type ExposureStatus = 'ok' | 'stale' | 'failed' | 'empty';

export interface ExposureRefreshResult {
  status: ExposureStatus;
  asOf: string;
  data?: PaymentExposure;
  staleSince?: string;
  error?: { code: string; message: string };
}

/** 取暴露：优先缓存；无缓存则尝试首刷，失败进入 failed/empty，绝不抛出未捕获错误（刷新失败可见、可追溯） */
export function getPaymentExposure(projectId: string, asOf = todayISO()): ExposureRefreshResult {
  projectOrThrow(projectId);
  const cached = exposureCache.get(projectId);
  const failure = exposureFailures.get(projectId);
  if (cached) {
    return { status: failure ? 'stale' : 'ok', asOf: cached.data.asOf, data: cached.data, ...(failure ? { staleSince: failure.at } : {}) };
  }
  try {
    const data = computeExposure(projectId, asOf);
    exposureCache.set(projectId, { data, refreshedAt: new Date().toISOString() });
    exposureFailures.delete(projectId);
    return { status: 'ok', asOf: data.asOf, data };
  } catch (err) {
    const code = err instanceof PaymentDataError ? err.code : 'EXPOSURE_COMPUTE_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    exposureFailures.set(projectId, { at: new Date().toISOString(), code, message });
    return { status: 'failed', asOf, error: { code, message } };
  }
}

/** 强制重算：成功替换缓存并清失败标记；失败保留旧快照并把状态降为 stale，两者都写审计 */
export function refreshPaymentExposure(projectId: string, actor = '制片主任', asOf = todayISO()): ExposureRefreshResult {
  projectOrThrow(projectId);
  const previous = exposureCache.get(projectId);
  try {
    const data = computeExposure(projectId, asOf);
    exposureCache.set(projectId, { data, refreshedAt: new Date().toISOString() });
    exposureFailures.delete(projectId);
    auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'EXPOSURE_REFRESH', entity: 'paymentExposure', entityId: projectId, actor, at: new Date().toISOString(), details: `付款暴露已刷新：30 天现金压力 ${data.totals.cashPressure30d}，已开票未付 ${data.totals.invoicedUnpaid}，交付前缺口 ${data.totals.preDeliveryShortfall}，风险 ${data.risks.length} 项`, projectId });
    return { status: 'ok', asOf: data.asOf, data };
  } catch (err) {
    const code = err instanceof PaymentDataError ? err.code : 'EXPOSURE_COMPUTE_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    exposureFailures.set(projectId, { at: new Date().toISOString(), code, message });
    auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'EXPOSURE_REFRESH_FAILED', entity: 'paymentExposure', entityId: projectId, actor, at: new Date().toISOString(), details: `付款暴露刷新失败（${code}）：${message}；${previous ? '保留上一份快照，状态降级为 stale' : '无可用快照'}`, projectId });
    return { status: previous ? 'stale' : 'failed', asOf, ...(previous ? { data: previous.data, staleSince: new Date().toISOString() } : {}), error: { code, message } };
  }
}

export function findPaymentRisk(projectId: string, riskId: string): PaymentRisk | undefined {
  const result = getPaymentExposure(projectId);
  return result.data?.risks.find(r => r.id === riskId);
}

/** 异常确认（确认审计）：把风险标记为已知悉，写入审计；刷新后按幂等 id 重新附回 */
export function acknowledgePaymentRisk(projectId: string, riskId: string, actor: string, comment = ''): PaymentRisk | undefined {
  const risk = findPaymentRisk(projectId, riskId);
  if (!risk) return undefined;
  const record = { at: new Date().toISOString(), actor, comment: comment || undefined };
  riskAcknowledgments.set(riskId, record);
  risk.acknowledged = record;
  auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'EXPOSURE_RISK_ACK', entity: 'paymentRisk', entityId: riskId, actor, at: record.at, details: `已确认付款风险【${risk.label}】${comment ? `：${comment}` : ''}（${risk.code}，金额 ${risk.amount}）`, projectId });
  return risk;
}

/** 交付日变更：会改变“交付日前未付/缓冲缺口”，因此立即作废该项目暴露缓存并写审计 */
export function rescheduleDelivery(projectId: string, newDate: string, actor: string, reason = ''): Project {
  const project = projectOrThrow(projectId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || Number.isNaN(Date.parse(newDate))) {
    throw new PaymentDataError('INVALID_DATE', `交付日格式非法：${newDate}`);
  }
  const previous = project.deliveryDate;
  if (newDate === previous) return project;
  project.deliveryDate = newDate;
  exposureCache.delete(projectId);
  exposureFailures.delete(projectId);
  auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'DELIVERY_RESCHEDULE', entity: 'project', entityId: projectId, actor, at: new Date().toISOString(), details: `交付日由 ${previous} 变更为 ${newDate}${reason ? `（${reason}）` : ''}；付款暴露缓存已作废，需重新刷新`, projectId });
  return project;
}

export interface PortfolioPaymentExposure { generatedAt: string; asOf: string; windowDays: number; definitions: typeof EXPOSURE_DEFINITIONS; projects: ExposureRefreshResult[]; totals: { cashPressure30d: number; invoicedUnpaid: number; overdueInvoiced: number; preDeliveryShortfall: number; openRiskCount: number; acknowledgedRiskCount: number }; }

/** 付款相关审计轨迹：刷新、刷新失败、风险确认、交付日变更（新事件在数组前部） */
export function paymentAuditTrail(projectId: string, limit = 20) {
  projectOrThrow(projectId);
  return auditEvents
    .filter(e => e.projectId === projectId || (e.entity === 'paymentRisk' && findPaymentRisk(projectId, e.entityId)?.projectId === projectId))
    .slice(0, limit);
}

/** 组合层汇总接口：每个项目保留独立 status（含 stale/failed），不掩盖单点刷新失败 */
export function portfolioPaymentExposure(asOf = todayISO()): PortfolioPaymentExposure {
  const items = projects.map(p => getPaymentExposure(p.id, asOf));
  const ok = items.filter(r => r.data);
  return {
    generatedAt: new Date().toISOString(), asOf, windowDays: 30, definitions: EXPOSURE_DEFINITIONS,
    projects: items,
    totals: {
      cashPressure30d: ok.reduce((a, r) => a + (r.data!.totals.cashPressure30d), 0),
      invoicedUnpaid: ok.reduce((a, r) => a + (r.data!.totals.invoicedUnpaid), 0),
      overdueInvoiced: ok.reduce((a, r) => a + (r.data!.totals.overdueInvoiced), 0),
      preDeliveryShortfall: ok.reduce((a, r) => a + (r.data!.totals.preDeliveryShortfall), 0),
      openRiskCount: ok.reduce((a, r) => a + r.data!.risks.filter(x => !x.acknowledged).length, 0),
      acknowledgedRiskCount: ok.reduce((a, r) => a + r.data!.risks.filter(x => x.acknowledged).length, 0),
    },
  };
}

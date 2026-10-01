import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acknowledgePaymentRisk, auditEvents, contracts, findPaymentRisk, getPaymentExposure,
  portfolioPaymentExposure, projectSummary, projects, refreshPaymentExposure,
  rescheduleDelivery, todayISO,
} from './domain.js';
import type { Contract, Project } from './domain.js';

const PID = 'PRJ-001';
const daysFromToday = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test('种子：逾期已开票被检出（CTR-02 版权证明 due 在过去且 invoiced）', () => {
  const r = refreshPaymentExposure(PID, '测试');
  assert.equal(r.status, 'ok');
  const e = r.data!;
  const overdue = e.risks.filter(x => x.code === 'OVERDUE_INVOICED');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].amount, 440000);
  assert.equal(e.totals.overdueInvoiced, 440000);
  assert.ok(overdue[0].traces[0].timelineDate! < todayISO());
});

test('种子：节点超合同额与累计超合同额（PRJ-002 CTR-04 1.1m > 1.0m）', () => {
  const r = refreshPaymentExposure('PRJ-002', '测试');
  const codes = r.data!.risks.map(x => x.code);
  assert.ok(codes.includes('MILESTONE_OVER_CEILING'));
  assert.ok(codes.includes('CONTRACT_OVER_CEILING'));
  const m = r.data!.risks.find(x => x.code === 'MILESTONE_OVER_CEILING')!;
  assert.equal(m.traces[0].contractId, 'CTR-04');
});

test('种子：无节点（CTR-05）且承诺超 ceiling，未付承诺计入 noMilestoneExposure', () => {
  const r = refreshPaymentExposure(PID, '测试');
  const no = r.data!.risks.find(x => x.code === 'NO_MILESTONE')!;
  assert.equal(no.traces[0].contractId, 'CTR-05');
  assert.equal(no.amount, 600000); // committed 900k - paid 300k
  assert.ok(r.data!.risks.some(x => x.code === 'COMMITTED_OVER_CEILING' && x.traces[0].contractId === 'CTR-05'));
  assert.equal(r.data!.totals.noMilestoneExposure, 600000);
});

test('同日付款：CTR-01 锁剪交付与调色初版同日（invoiced+open）并入一组', () => {
  const r = refreshPaymentExposure(PID, '测试');
  const g = r.data!.timeline.find(x => x.date === daysFromToday(8))!;
  assert.equal(g.nodes.length, 2);
  assert.equal(g.dayAmount, 2300000);
  assert.equal(g.dayInvoicedUnpaid, 1200000);
});

test('未来30天现金压力与已开票未付按口径汇总', () => {
  const e = refreshPaymentExposure(PID, '测试').data!;
  // 窗内未付：CTR-01 1.2m+1.1m（第8天）；CTR-02 已逾期不计窗口；母版第36天不计
  assert.equal(e.totals.cashPressure30d, 2300000);
  assert.equal(e.totals.cashPressure30dInvoiced, 1200000);
  // 已开票未付：CTR-01 1.2m + CTR-02 0.44m
  assert.equal(e.totals.invoicedUnpaid, 1640000);
  // 承诺未付：(4.3m-2.3m)+(0.88m-0.44m)+(0.9m-0.3m)=3.04m
  assert.equal(e.totals.outstandingCommitted, 3040000);
});

test('交付日前缺预算缓冲（PRJ-001 预算偏差为正，buffer=0），风险追溯多节点', () => {
  const e = refreshPaymentExposure(PID, '测试').data!;
  assert.equal(e.totals.budgetBuffer, 0);
  assert.ok(e.totals.preDeliveryShortfall > 0);
  assert.equal(e.totals.preDeliveryShortfall, e.totals.preDeliveryUnpaid);
  const r = e.risks.find(x => x.code === 'BUFFER_SHORTFALL_PROJECT')!;
  assert.equal(r.level, 'critical');
  assert.ok(r.traces.length >= 4);
});

test('兼容原摘要接口：原字段不变，新增 paymentExposure/paymentDefinitions', () => {
  const s = projectSummary(PID);
  assert.equal(s.lines.length, 4);
  assert.ok(s.forecast > s.planned);
  assert.equal(s.highRiskLines.length, 1);
  // 原 contractExposure 口径不变（ceiling 合计）
  assert.equal(s.contractExposure, 5200000 + 880000 + 700000);
  assert.equal(s.paymentExposure.status, 'ok');
  assert.ok(s.paymentExposure.data!.totals);
  assert.match(s.paymentDefinitions.exposure, /committed - paid/);
  assert.ok(Array.isArray(s.contracts));
});

test('刷新成功写审计；getPaymentExposure 命中缓存返回同一快照', () => {
  const r1 = refreshPaymentExposure(PID, '财务小李');
  assert.equal(r1.status, 'ok');
  assert.equal(auditEvents[0].action, 'EXPOSURE_REFRESH');
  assert.equal(auditEvents[0].actor, '财务小李');
  const r2 = getPaymentExposure(PID);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.data, r1.data); // 同一份缓存
});

test('刷新失败：数据损坏时保留旧快照降级 stale 并写失败审计；恢复后刷新清除', () => {
  refreshPaymentExposure(PID, '测试');
  const ctr = contracts.find(c => c.id === 'CTR-01')!;
  const originalCeiling = ctr.ceiling;
  try {
    ctr.ceiling = -1; // 模拟刷新时读到损坏数据
    const result = refreshPaymentExposure(PID, '测试');
    assert.equal(result.status, 'stale');
    assert.ok(result.data); // 仍带旧快照
    assert.equal(result.error?.code, 'INVALID_AMOUNT');
    assert.equal(auditEvents[0].action, 'EXPOSURE_REFRESH_FAILED');
    assert.match(auditEvents[0].details, /快照/);
    // 读取也呈现 stale
    const got = getPaymentExposure(PID);
    assert.equal(got.status, 'stale');
    assert.ok(got.staleSince);
  } finally {
    ctr.ceiling = originalCeiling;
  }
  // 恢复后刷新成功，失败标记清除
  const recovered = refreshPaymentExposure(PID, '测试');
  assert.equal(recovered.status, 'ok');
  assert.equal(getPaymentExposure(PID).status, 'ok');
});

test('首次即失败（无缓存）：status=failed、无 data、带错误码', () => {
  const badProject: Project = { id: 'PRJ-BAD', code: 'BAD', title: '坏数据项目', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'B', deliveryDate: '2026-12-01' };
  const badContract: Contract = { id: 'CTR-BAD', projectId: 'PRJ-BAD', vendor: '坏', scope: '', ceiling: -1, committed: 0, paid: 0, milestones: [] };
  projects.push(badProject);
  contracts.push(badContract);
  try {
    const r = getPaymentExposure('PRJ-BAD');
    assert.equal(r.status, 'failed');
    assert.equal(r.data, undefined);
    assert.equal(r.error?.code, 'INVALID_AMOUNT');
    // 无缓存刷新同样 failed 且无快照
    const r2 = refreshPaymentExposure('PRJ-BAD', '测试');
    assert.equal(r2.status, 'failed');
    assert.equal(r2.data, undefined);
    assert.equal(auditEvents[0].action, 'EXPOSURE_REFRESH_FAILED');
  } finally {
    projects.splice(projects.indexOf(badProject), 1);
    contracts.splice(contracts.indexOf(badContract), 1);
  }
});

test('未知项目：getPaymentExposure 抛 PaymentDataError（路由映射为错误响应）', () => {
  assert.throws(() => getPaymentExposure('PRJ-NOPE'), /项目不存在/);
});

test('异常确认审计：确认后风险带 acknowledged、写审计，刷新后仍保留', () => {
  refreshPaymentExposure(PID, '测试');
  const risk = refreshPaymentExposure(PID, '测试').data!.risks.find(x => x.code === 'OVERDUE_INVOICED' && x.traces[0].contractId === 'CTR-02')!;
  const acked = acknowledgePaymentRisk(PID, risk.id, '制片主任', '已与供应商约定本周补付')!;
  assert.equal(acked.acknowledged?.actor, '制片主任');
  assert.match(acked.acknowledged?.comment ?? '', /本周补付/);
  assert.equal(auditEvents[0].action, 'EXPOSURE_RISK_ACK');
  assert.equal(auditEvents[0].entityId, risk.id);
  // 强制重建后，按幂等 id 从确认台账重新附回
  refreshPaymentExposure(PID, '测试');
  const again = findPaymentRisk(PID, risk.id)!;
  assert.ok(again.acknowledged);
  assert.equal(again.acknowledged?.actor, '制片主任');
});

test('确认不存在的风险返回 undefined', () => {
  assert.equal(acknowledgePaymentRisk(PID, 'NOT-A-RISK', 'x'), undefined);
});

test('交付日变更：缓存作废、交付前未付随之变化、写 DELIVERY_RESCHEDULE 审计', () => {
  const preBefore = refreshPaymentExposure(PID, '测试').data!.totals.preDeliveryUnpaid;
  const originalDelivery = projects.find(p => p.id === PID)!.deliveryDate;
  const near = daysFromToday(1);
  try {
    const updated = rescheduleDelivery(PID, near, '制片主任', '客户提前要片');
    assert.equal(updated.deliveryDate, near);
    assert.equal(auditEvents[0].action, 'DELIVERY_RESCHEDULE');
    assert.match(auditEvents[0].details, /付款暴露缓存已作废/);
    // 缓存已作废，重新读取触发首刷；只剩逾期票仍在交付日前
    const after = getPaymentExposure(PID).data!;
    assert.ok(after.totals.preDeliveryUnpaid < preBefore);
    assert.equal(after.totals.preDeliveryUnpaid, 440000);
    assert.equal(after.project.deliveryDate, near);
    assert.ok(after.timeline.some(g => g.isDelivery && g.date === near));
  } finally {
    rescheduleDelivery(PID, originalDelivery, '测试', '恢复测试');
  }
  assert.equal(getPaymentExposure(PID).data!.project.deliveryDate, originalDelivery);
});

test('交付日变更为非法日期抛错且不动数据', () => {
  assert.throws(() => rescheduleDelivery(PID, 'not-a-date', 'x'), /交付日格式非法/);
});

test('组合汇总：跨项目合计并保留每项目独立 status', () => {
  refreshPaymentExposure(PID, '测试');
  refreshPaymentExposure('PRJ-002', '测试');
  const pf = portfolioPaymentExposure();
  assert.equal(pf.projects.length, 2);
  assert.ok(pf.projects.every(p => p.status === 'ok'));
  const sum30 = pf.projects.reduce((a, p) => a + (p.data?.totals.cashPressure30d ?? 0), 0);
  assert.equal(pf.totals.cashPressure30d, sum30);
  assert.ok(pf.totals.openRiskCount >= 1);
  assert.match(pf.definitions.payment, /paid/);
});

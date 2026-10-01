import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEvents, contracts, projects } from './domain.js';
import { acknowledgeRisk, paymentExposure, paymentNodeDetail, refreshPaymentExposure, updateDeliveryDate } from './paymentExposure.js';

const iso = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const withContract = (contract: typeof contracts[number], fn: () => void) => { contracts.push(contract); try { fn(); } finally { contracts.splice(contracts.indexOf(contract), 1); } };

test('exposure totals follow committed/invoiced/paid definitions and 30-day window', () => {
  const exposure = paymentExposure('PRJ-001', 30);
  assert.ok(exposure);
  assert.equal(exposure.totals.committed, 4300000 + 880000);
  assert.equal(exposure.totals.invoiced, 1200000 + 440000 + 440000);
  assert.equal(exposure.totals.paid, 2300000 + 440000);
  assert.equal(exposure.totals.unpaidCommitted, exposure.totals.committed - exposure.totals.paid);
  assert.ok(exposure.totals.dueWithinWindow >= 1200000 + 440000);
  assert.equal(exposure.definitions.committed.includes('已承诺'), true);
});

test('overdue invoiced milestone raises critical risk and is traceable to its node', () => {
  withContract({ id: 'CTR-T1', projectId: 'PRJ-001', vendor: '测试供应商', scope: '测试', ceiling: 100000, committed: 80000, paid: 0, milestones: [{ name: '逾期节点', due: iso(-5), amount: 60000, status: 'invoiced' }] }, () => {
    const exposure = paymentExposure('PRJ-001');
    const risk = exposure?.risks.find(item => item.kind === 'overdue_invoiced' && item.nodeIds.includes('CTR-T1#1'));
    assert.ok(risk);
    assert.equal(risk.severity, 'critical');
    assert.equal(risk.amount, 60000);
    assert.equal(exposure?.totals.overdueInvoiced, 60000);
    const detail = paymentNodeDetail(risk.nodeIds[0]);
    assert.equal(detail?.node?.id, 'CTR-T1#1');
    assert.equal(detail?.contract.vendor, '测试供应商');
    assert.ok(detail?.risks.some(item => item.id === risk.id));
  });
});

test('milestone total above contract ceiling raises ceiling_breach risk', () => {
  withContract({ id: 'CTR-T2', projectId: 'PRJ-001', vendor: '超限供应商', scope: '测试', ceiling: 100000, committed: 90000, paid: 0, milestones: [{ name: '节点一', due: iso(10), amount: 70000, status: 'open' }, { name: '节点二', due: iso(20), amount: 60000, status: 'open' }] }, () => {
    const risk = paymentExposure('PRJ-001')?.risks.find(item => item.kind === 'ceiling_breach' && item.contractId === 'CTR-T2');
    assert.ok(risk);
    assert.equal(risk.amount, 30000);
    assert.deepEqual(risk.nodeIds, ['CTR-T2#1', 'CTR-T2#2']);
  });
});

test('delivery date change recomputes pre-delivery exposure and writes audit', () => {
  const project = projects.find(item => item.id === 'PRJ-002');
  const original = project?.deliveryDate ?? '';
  const before = paymentExposure('PRJ-002');
  try {
    const result = updateDeliveryDate('PRJ-002', iso(10), '制片主任');
    assert.ok(result);
    assert.equal(result.previous, original);
    assert.ok(result.exposure);
    assert.ok(before && result.exposure.totals.preDeliveryUnpaid < before.totals.preDeliveryUnpaid);
    assert.ok(auditEvents.some(event => event.action === 'DELIVERY_DATE_CHANGED' && event.entityId === 'PRJ-002'));
  } finally { if (project) project.deliveryDate = original; }
});

test('contract without milestones surfaces unscheduled_commitment risk', () => {
  withContract({ id: 'CTR-T3', projectId: 'PRJ-001', vendor: '无节点供应商', scope: '测试', ceiling: 500000, committed: 300000, paid: 100000, milestones: [] }, () => {
    const risk = paymentExposure('PRJ-001')?.risks.find(item => item.kind === 'unscheduled_commitment' && item.contractId === 'CTR-T3');
    assert.ok(risk);
    assert.equal(risk.amount, 200000);
    assert.deepEqual(risk.nodeIds, []);
  });
});

test('same-day payments cluster into one timeline event and a warning risk', () => {
  withContract({ id: 'CTR-T4', projectId: 'PRJ-001', vendor: '同日供应商', scope: '测试', ceiling: 900000, committed: 800000, paid: 0, milestones: [{ name: '节点甲', due: iso(12), amount: 300000, status: 'open' }, { name: '节点乙', due: iso(12), amount: 400000, status: 'invoiced' }] }, () => {
    const exposure = paymentExposure('PRJ-001');
    const event = exposure?.timeline.find(item => item.nodes.some(node => node.id === 'CTR-T4#1'));
    assert.equal(event?.nodes.length, 2);
    assert.equal(event?.amount, 700000);
    const risk = exposure?.risks.find(item => item.kind === 'same_day_cluster' && item.nodeIds.includes('CTR-T4#2'));
    assert.ok(risk);
    assert.equal(risk.severity, 'warning');
  });
});

test('refresh fails on inconsistent ledger, keeps previous snapshot and audits failure', () => {
  const good = refreshPaymentExposure('PRJ-001', '测试员');
  assert.equal(good?.ok, true);
  withContract({ id: 'CTR-T5', projectId: 'PRJ-001', vendor: '异常供应商', scope: '测试', ceiling: 100000, committed: 50000, paid: 80000, milestones: [] }, () => {
    const failed = refreshPaymentExposure('PRJ-001', '测试员');
    assert.ok(failed && !failed.ok);
    assert.ok(failed.errors.some(error => error.includes('CTR-T5')));
    assert.ok(failed.snapshot);
    assert.ok(auditEvents.some(event => event.action === 'EXPOSURE_REFRESH_FAILED' && event.entityId === 'PRJ-001'));
  });
});

test('risk acknowledgement is stateful and audited', () => {
  const exposure = paymentExposure('PRJ-001');
  const target = exposure?.risks.find(item => !item.acknowledged);
  assert.ok(target);
  const acknowledged = acknowledgeRisk('PRJ-001', target.id, '制片主任', '锁剪前现金已预留');
  assert.equal(acknowledged?.acknowledged, true);
  assert.equal(paymentExposure('PRJ-001')?.risks.find(item => item.id === target.id)?.acknowledged, true);
  const event = auditEvents.find(item => item.action === 'RISK_ACKNOWLEDGED' && item.entityId === target.id);
  assert.ok(event);
  assert.equal(event.details.includes('锁剪前现金已预留'), true);
  assert.equal(acknowledgeRisk('PRJ-001', 'nonexistent:risk', '制片主任'), undefined);
});

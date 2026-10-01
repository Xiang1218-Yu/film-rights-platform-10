import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaymentExposure, PaymentDataError } from './paymentExposure.js';
import type { Contract, Project } from './domain.js';
import type { BudgetLine } from './domain.js';

const AS_OF = '2026-10-01';

const project: Project = {
  id: 'PRJ-T', code: 'T-S1', title: '测试项目', season: 1, status: 'post',
  currency: 'CNY', budgetVersionId: 'BUD-T', deliveryDate: '2026-11-15',
};

const contracts: Contract[] = [
  { // A：逾期已开票 + 30天内 open + 交付前但窗外 invoiced
    id: 'CTR-A', projectId: 'PRJ-T', vendor: '供应商A', scope: '后期', ceiling: 1000000, committed: 900000, paid: 200000,
    milestones: [
      { name: '逾期票', due: '2026-09-20', amount: 300000, status: 'invoiced' },
      { name: '窗内款', due: '2026-10-10', amount: 200000, status: 'open' },
      { name: '窗前票', due: '2026-11-01', amount: 400000, status: 'invoiced' },
    ],
  },
  { // B：单节点超合同额 → 同时累计超合同额
    id: 'CTR-B', projectId: 'PRJ-T', vendor: '供应商B', scope: '视效', ceiling: 500000, committed: 500000, paid: 0,
    milestones: [{ name: '超额预付', due: '2026-10-15', amount: 600000, status: 'invoiced' }],
  },
  { // C：无节点且承诺超合同额
    id: 'CTR-C', projectId: 'PRJ-T', vendor: '供应商C', scope: '器材', ceiling: 250000, committed: 300000, paid: 0, milestones: [],
  },
  { // D：同日两笔付款 + 承诺未排满
    id: 'CTR-D', projectId: 'PRJ-T', vendor: '供应商D', scope: '交通', ceiling: 300000, committed: 250000, paid: 0,
    milestones: [
      { name: '同日一', due: '2026-10-20', amount: 100000, status: 'open' },
      { name: '同日二', due: '2026-10-20', amount: 100000, status: 'open' },
    ],
  },
];

const budgetLines: BudgetLine[] = [
  { id: 'L1', projectId: 'PRJ-T', category: '制作', subcategory: '主', planned: 1000000, committed: 0, actual: 0, forecast: 900000, owner: 'x', risk: 'low' },
];

const build = () => buildPaymentExposure({ project, contracts, budgetLines }, AS_OF);

test('口径：承诺/开票/支付/暴露/缓冲定义随结果下发', () => {
  const e = build();
  assert.match(e.definitions.commitment, /committed/);
  assert.match(e.definitions.invoicing, /invoiced/);
  assert.match(e.definitions.payment, /paid/);
  assert.match(e.definitions.exposure, /max\(committed - paid, 0\)/);
  assert.match(e.definitions.budgetBuffer, /max\(planned - forecast, 0\)/);
});

test('汇总口径：承诺未付=committed-paid，已开票未付只计 invoiced', () => {
  const e = build();
  // ceiling 1.0m + .5m + .25m + .3m
  assert.equal(e.totals.ceiling, 2050000);
  // committed .9m + .5m + .3m + .25m
  assert.equal(e.totals.committed, 1950000);
  assert.equal(e.totals.paid, 200000);
  assert.equal(e.totals.outstandingCommitted, 1750000);
  // invoiced: A 300k+400k, B 600k = 1.3m；paid 节点不计
  assert.equal(e.totals.invoicedUnpaid, 1300000);
});

test('未来30天现金压力：窗口为 [asOf, asOf+30]，paid/逾期不计', () => {
  const e = build();
  // 窗内：A 窗内款 200k(open) + B 600k(invoiced) + D 同日两笔 200k = 1.0m
  assert.equal(e.totals.cashPressure30d, 1000000);
  // 其中已开票部分仅 B 600k
  assert.equal(e.totals.cashPressure30dInvoiced, 600000);
  assert.equal(e.window.next30d.nodeCount, 4);
  // 边界：A 窗前票 11-01 = asOf+31，不计入窗口
  assert.equal(e.contracts.find(c => c.contractId === 'CTR-A')!.milestones[2].within30d, false);
});

test('逾期已开票：invoiced 且 due<asOf 判 critical，金额计入逾期暴露', () => {
  const e = build();
  assert.equal(e.totals.overdueInvoiced, 300000);
  assert.equal(e.window.overdue.nodeCount, 1);
  const r = e.risks.find(x => x.code === 'OVERDUE_INVOICED')!;
  assert.equal(r.level, 'critical');
  assert.equal(r.amount, 300000);
  assert.equal(r.traces[0].contractId, 'CTR-A');
  assert.equal(r.traces[0].milestoneIndex, 0);
  assert.equal(r.traces[0].timelineDate, '2026-09-20');
  assert.equal(e.contracts[0].milestones[0].overdue, true);
});

test('节点超合同额：单节点与累计两条风险均可追溯到原节点', () => {
  const e = build();
  const single = e.risks.find(x => x.code === 'MILESTONE_OVER_CEILING')!;
  assert.equal(single.amount, 600000);
  assert.equal(single.level, 'critical');
  assert.equal(single.traces[0].contractId, 'CTR-B');
  assert.equal(single.traces[0].milestoneIndex, 0);
  const total = e.risks.find(x => x.code === 'CONTRACT_OVER_CEILING')!;
  assert.equal(total.amount, 100000); // 600k - 500k
  assert.equal(total.traces.length, 1);
  const view = e.contracts.find(c => c.contractId === 'CTR-B')!;
  assert.ok(view.ceilingHeadroom < 0);
  assert.ok(view.riskIds.includes(single.id));
});

test('无节点：承诺未付计为 noMilestoneExposure 且给出 NO_MILESTONE 风险', () => {
  const e = build();
  assert.equal(e.totals.noMilestoneExposure, 300000);
  const r = e.risks.find(x => x.code === 'NO_MILESTONE')!;
  assert.equal(r.traces[0].contractId, 'CTR-C');
  // 承诺 300k 超 ceiling 250k
  assert.ok(e.risks.some(x => x.code === 'COMMITTED_OVER_CEILING' && x.amount === 50000));
});

test('承诺未排进节点：committed > 节点合计时给 SCHEDULE_MISMATCH', () => {
  const e = build();
  const r = e.risks.find(x => x.code === 'SCHEDULE_MISMATCH')!;
  assert.equal(r.traces[0].contractId, 'CTR-D');
  assert.equal(r.amount, 50000); // 250k - 200k
  const d = e.contracts.find(c => c.contractId === 'CTR-D')!;
  assert.equal(d.unmilestonedCommitted, 50000);
});

test('同日付款：同一天两笔合并到一个时间线组，日额为两笔之和', () => {
  const e = build();
  const g = e.timeline.find(x => x.date === '2026-10-20')!;
  assert.equal(g.nodes.length, 2);
  assert.equal(g.dayAmount, 200000);
  assert.deepEqual(g.nodes.map(n => n.name).sort(), ['同日一', '同日二']);
});

test('时间线：按日排序、累计未付、交付日单独成组（无节点也保留）', () => {
  const e = build();
  const dates = e.timeline.map(g => g.date);
  assert.deepEqual(dates, [...dates].sort());
  const delivery = e.timeline.find(g => g.isDelivery)!;
  assert.equal(delivery.date, '2026-11-15');
  assert.equal(delivery.relativeDay, 45);
  assert.equal(delivery.nodes.length, 0);
  // 交付日组累计 = 全部交付日前未付
  assert.equal(delivery.cumulativeOutstanding, e.totals.preDeliveryUnpaid);
  const overdue = e.timeline.find(g => g.date === '2026-09-20')!;
  assert.equal(overdue.relativeDay, -11);
  assert.equal(overdue.cumulativeOutstanding, 300000);
});

test('交付日前缺预算缓冲：缺口=交付前未付-buffer，风险追溯到每个相关节点', () => {
  const e = build();
  // buffer = max(1.0m - 0.9m, 0) = 100k
  assert.equal(e.totals.budgetBuffer, 100000);
  // 交付前未付：A 900k + B 600k + D 200k = 1.7m
  assert.equal(e.totals.preDeliveryUnpaid, 1700000);
  assert.equal(e.totals.preDeliveryShortfall, 1600000);
  const r = e.risks.find(x => x.code === 'BUFFER_SHORTFALL_PROJECT')!;
  assert.equal(r.amount, 1600000);
  // A×3 + B×1 + D×2 = 6 个原节点，可从风险逐一回跳
  assert.equal(r.traces.length, 6);
  assert.ok(r.traces.every(t => t.timelineDate && t.contractId));
  // 相关节点被回填 bufferShortfall 与 riskIds
  assert.ok(e.contracts[0].milestones[0].bufferShortfall);
  assert.ok(e.contracts[0].milestones[0].riskIds.includes(r.id));
});

test('从风险回到原节点：trace 坐标能在时间线中唯一定位节点', () => {
  const e = build();
  const overdue = e.risks.find(x => x.code === 'OVERDUE_INVOICED')!;
  const t = overdue.traces[0];
  const group = e.timeline.find(g => g.date === t.timelineDate)!;
  const node = group.nodes.find(n => n.contractId === t.contractId && n.milestoneIndex === t.milestoneIndex)!;
  assert.equal(node.name, '逾期票');
  assert.equal(node.amount, 300000);
});

test('数据校验：负金额与非法日期抛 PaymentDataError（用于刷新失败语义）', () => {
  const badAmount: Contract = { ...contracts[0], id: 'CTR-X', ceiling: -1 };
  assert.throws(
    () => buildPaymentExposure({ project, contracts: [badAmount], budgetLines }, AS_OF),
    (err: unknown) => err instanceof PaymentDataError && err.code === 'INVALID_AMOUNT',
  );
  const badDate: Contract = { ...contracts[0], id: 'CTR-Y', milestones: [{ name: 'x', due: '2026-02-30', amount: 1, status: 'open' }] };
  assert.throws(
    () => buildPaymentExposure({ project, contracts: [badDate], budgetLines }, AS_OF),
    (err: unknown) => err instanceof PaymentDataError && err.code === 'INVALID_DATE',
  );
  const badFormat: Contract = { ...contracts[0], id: 'CTR-Z', milestones: [{ name: 'x', due: '10/10/2026', amount: 1, status: 'open' }] };
  assert.throws(
    () => buildPaymentExposure({ project, contracts: [badFormat], budgetLines }, AS_OF),
    (err: unknown) => err instanceof PaymentDataError && err.code === 'INVALID_DATE',
  );
});

test('不存在项目交付日等非法基准日期同样被拒绝', () => {
  assert.throws(
    () => buildPaymentExposure({ project: { ...project, deliveryDate: 'bad' }, contracts: [], budgetLines: [] }, AS_OF),
    /deliveryDate/,
  );
});

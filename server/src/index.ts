import express from 'express';
import { acknowledgePaymentRisk, approve, assets, budgetLines, contracts, createApproval, dashboard, getPaymentExposure, paymentAuditTrail, portfolioPaymentExposure, projectSummary, projects, refreshPaymentExposure, rescheduleDelivery, rightsConflicts } from './domain.js';
const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => { const result = projectSummary(req.params.id); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); });
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));

// ---- 付款暴露模块 ----
// 暴露为信封：status=ok|stale|failed，刷新失败时仍可返回旧快照，前端据此显示“数据可能已过期”
app.get('/api/projects/:id/payment-exposure', (req, res) => {
  try {
    const result = getPaymentExposure(req.params.id);
    if (result.status === 'failed' && !result.data) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    return res.status(404).json({ message: err instanceof Error ? err.message : '项目不存在' });
  }
});
// 强制重算：成功 200，失败但有旧快照 200(stale)，失败且无快照 422；审计均落事件
app.post('/api/projects/:id/payment-exposure/refresh', (req, res) => {
  try {
    const result = refreshPaymentExposure(req.params.id, req.body?.actor || '制片主任');
    if (result.status === 'failed' && !result.data) return res.status(422).json(result);
    res.json(result);
  } catch (err) {
    return res.status(404).json({ message: err instanceof Error ? err.message : '项目不存在' });
  }
});
app.post('/api/projects/:id/risks/:riskId/acknowledge', (req, res) => {
  try {
    const risk = acknowledgePaymentRisk(req.params.id, req.params.riskId, req.body?.actor || '制片主任', req.body?.comment || '');
    if (!risk) return res.status(404).json({ message: '风险不存在或已随刷新消失' });
    res.json(risk);
  } catch (err) {
    return res.status(404).json({ message: err instanceof Error ? err.message : '项目不存在' });
  }
});
app.patch('/api/projects/:id/delivery-date', (req, res) => {
  try {
    const project = rescheduleDelivery(req.params.id, String(req.body?.deliveryDate ?? ''), req.body?.actor || '制片主任', req.body?.reason || '');
    res.json(project);
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : '交付日变更失败' });
  }
});
app.get('/api/payment-exposure', (_req, res) => res.json(portfolioPaymentExposure()));
app.get('/api/projects/:id/payment-audit', (req, res) => {
  try {
    res.json(paymentAuditTrail(req.params.id));
  } catch (err) {
    return res.status(404).json({ message: err instanceof Error ? err.message : '项目不存在' });
  }
});

app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(req.params.id, req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
const port = Number(process.env.PORT || 4104); app.listen(port, () => console.log(`film rights API listening on ${port}`));

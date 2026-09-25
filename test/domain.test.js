import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseDomain,
  scanVerification,
  evaluateNetworkGate,
  checkParcelGateConsistency,
  validateLeadFlow,
  appendSupplement,
  departmentView,
  traceParcel,
  activeLeadsForParcel
} from '../src/domain.js';

const FIXTURE_URL = new URL('../fixtures/domain.json', import.meta.url);

async function loadDomain() {
  return parseDomain(await readFile(FIXTURE_URL, 'utf8'));
}

test('领域资料结构完整且引用一致', async () => {
  const d = await loadDomain();
  assert.equal(d.domain, 'food-parcel-supervision');
  assert.ok(d.version >= 2);
  assert.deepEqual(d.departments.map((x) => x.code).sort(), ['market', 'postal']);
  assert.ok(d.constraints.length >= 10);
});

test('资料缺字段或引用断裂时拒绝解析', async () => {
  const d = await loadDomain();
  assert.throws(() => parseDomain(JSON.stringify({ ...d, leads: undefined })), /内容不完整/);

  const broken = structuredClone(d);
  broken.parcels.push({ parcel_no: 'P-X', batch_id: 'B-NONE', status: 'in_network', blocked_gap: null });
  assert.throws(() => parseDomain(JSON.stringify(broken)), /批次/);

  const duplicated = structuredClone(d);
  duplicated.customers[1].qualification_snapshot.verification_code =
    duplicated.customers[0].qualification_snapshot.verification_code;
  assert.throws(() => parseDomain(JSON.stringify(duplicated)), /一码一核验/);
});

test('同一核验码反复扫码只形成一次核验', async () => {
  const d = await loadDomain();
  const snapshotHash = d.customers[0].qualification_snapshot.code_payload_hash;
  const before = d.verifications.find((v) => v.verification_code === 'VC-HUNAN-1001').scan_attempts;

  const r1 = scanVerification(d, 'VC-HUNAN-1001', { payload_hash: snapshotHash, at: '2026-09-02T09:10:00+08:00' });
  const r2 = scanVerification(d, 'VC-HUNAN-1001', { payload_hash: snapshotHash, at: '2026-09-02T09:12:00+08:00' });

  assert.equal(r1.outcome, 'ALREADY_VERIFIED');
  assert.equal(r1.verification_count, 1);
  assert.equal(r2.verification_count, 1);
  assert.equal(r2.scan_attempts, before + 2);
  // 重试不新增核验记录。
  assert.equal(d.verifications.filter((v) => v.verification_code === 'VC-HUNAN-1001').length, 1);
});

test('同一码内容相对快照改变立即隔离', async () => {
  const d = await loadDomain();
  // fixture 中 VC-HUNAN-1002 首次扫码内容已与快照不一致。
  const gate = evaluateNetworkGate(d, 'P-9004');
  assert.equal(gate.admitted, false);
  assert.equal(gate.gap, 'CODE_TAMPERED');

  // 已通过核验的码若再次扫码内容改变，同样立即隔离。
  const r = scanVerification(d, 'VC-HUNAN-1001', {
    payload_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    at: '2026-09-03T08:00:00+08:00'
  });
  assert.equal(r.outcome, 'CONTENT_CHANGED');
  assert.equal(r.quarantined, true);
  assert.equal(evaluateNetworkGate(d, 'P-9001').gap, 'CODE_TAMPERED');
});

test('未知核验码不得入网', async () => {
  const d = await loadDomain();
  const r = scanVerification(d, 'VC-FAKE', { payload_hash: 'sha256:aa', at: '2026-09-03T08:00:00+08:00' });
  assert.equal(r.quarantined, true);
  assert.equal(r.gap, 'CODE_TAMPERED');
});

test('实际揽件地与登记场所及外设仓库均不符时，包裹停在场所缺口', async () => {
  const d = await loadDomain();
  const gate = evaluateNetworkGate(d, 'P-9003');
  assert.equal(gate.admitted, false);
  assert.equal(gate.gap, 'SITE_MISMATCH');
  assert.match(gate.reason, /未登记/);
});

test('登记外设仓库揽件、三检通过、温控复测回稳且线索已解除的包裹可入网', async () => {
  const d = await loadDomain();
  // P-9002 在已登记外设仓库揽件；交接中9.4℃超标，但末次交接复测6.0℃回稳；线索L-403已解除。
  assert.equal(activeLeadsForParcel(d, 'P-9002').length, 0);
  const gate = evaluateNetworkGate(d, 'P-9002');
  assert.equal(gate.admitted, true);
  assert.equal(gate.gap, null);
});

test('存在生效线索的包裹不得进入网络，合并线索跟随主线索生效', async () => {
  const d = await loadDomain();
  // 构造一个场所合规但挂着调查中线索的包裹视图：直接核验生效线索计算。
  const active = activeLeadsForParcel(d, 'P-9003');
  assert.ok(active.some((l) => l.lead_id === 'L-401'));
  // L-404 已合并进 L-401，不重复阻断但仍视为指向同一风险。
  assert.ok(active.some((l) => l.lead_id === 'L-404'));
  const released = activeLeadsForParcel(d, 'P-9002');
  assert.equal(released.length, 0);
});

test('资料中每个包裹的记录状态与闸门实时判定一致', async () => {
  const d = await loadDomain();
  assert.deepEqual(checkParcelGateConsistency(d), []);
});

test('市场监管处置必须在邮政确认寄递事实之后', async () => {
  const d = await loadDomain();
  for (const lead of d.leads) {
    const result = validateLeadFlow(d, lead.lead_id);
    assert.deepEqual(result.errors, [], `${lead.lead_id} 流转校验失败`);
  }

  const bad = structuredClone(d);
  const target = bad.leads.find((l) => l.lead_id === 'L-402');
  // 删掉邮政确认环节，市场监管受理变成越位。
  target.postal_confirmation = null;
  target.events = target.events.filter((e) => e.type !== 'POSTAL_CONFIRMED');
  const result = validateLeadFlow(bad, 'L-402');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /寄递事实确认/.test(e)));
});

test('冻结后补充材料只能追加版本，不能覆盖', async () => {
  const d = await loadDomain();
  const added = appendSupplement(d, 'L-401', {
    title: '望城仓库协查回函',
    content_ref: 'EVID-L401-V3',
    added_at: '2026-09-16T10:00:00+08:00'
  });
  assert.equal(added.version, 3);
  assert.deepEqual(d.leads.find((l) => l.lead_id === 'L-401').supplements.map((s) => s.version), [1, 2, 3]);
  assert.equal(validateLeadFlow(d, 'L-401').valid, true);

  // 未冻结线索不得走冻结补充通道。
  assert.throws(() => appendSupplement(d, 'L-402', {
    title: '不应进入',
    content_ref: 'X',
    added_at: '2026-09-20T10:00:00+08:00'
  }), /未冻结/);

  const tampered = structuredClone(d);
  const t = tampered.leads.find((l) => l.lead_id === 'L-401');
  t.supplements[0].content_ref = 'EVID-OVERWRITTEN';
  t.events.push({ seq: 99, type: 'SUPPLEMENT_APPENDED', at: '2026-09-17T10:00:00+08:00', version: 2 });
  const result = validateLeadFlow(tampered, 'L-401');
  assert.ok(result.errors.some((e) => /覆盖|追加/.test(e)));
});

test('退回补正与跨辖区移交携带原期限和回执，部门切换不重新计时', async () => {
  const d = await loadDomain();
  const lead = d.leads.find((l) => l.lead_id === 'L-401');
  const correction = lead.events.find((e) => e.type === 'RETURNED_FOR_CORRECTION');
  const transfer = lead.events.find((e) => e.type === 'TRANSFERRED');
  assert.equal(correction.preserved_due_at, lead.origin_due_at);
  assert.equal(transfer.preserved_due_at, lead.origin_due_at);
  assert.ok(correction.receipt_id && transfer.receipt_id);
  assert.equal(transfer.to_jurisdiction, lead.current_jurisdiction);

  // 移交时若重新起算期限，校验必须报错。
  const bad = structuredClone(d);
  const t = bad.leads.find((l) => l.lead_id === 'L-401');
  t.events.find((e) => e.type === 'TRANSFERRED').preserved_due_at = '2026-10-15T18:00:00+08:00';
  const result = validateLeadFlow(bad, 'L-401');
  assert.ok(result.errors.some((e) => /重新计时|原始期限/.test(e)));
});

test('两部门只读取职责所需字段，举报人身份在常规视图中一律封存', async () => {
  const d = await loadDomain();
  const postal = departmentView(d, 'postal');
  const market = departmentView(d, 'market');

  // 邮政看批次需要快递员与交接；市场监管职责不需要快递员工号。
  assert.ok('courier_id' in postal.pickup_batches[0]);
  assert.ok(!('courier_id' in market.pickup_batches[0]));

  // 市场监管需要许可证与登记场所；邮政的资质视图不含证号。
  assert.equal(market.customers[0].qualification_snapshot.license_no, d.customers[0].qualification_snapshot.license_no);
  assert.ok(!('license_no' in postal.customers[0].qualification_snapshot));

  // 举报人身份不进入任一部门的常规视图。
  for (const view of [postal, market]) {
    for (const r of view.reports) {
      assert.ok(!('reporter_sealed' in r));
    }
    const flat = JSON.stringify(view);
      assert.ok(!flat.includes('vault://reporter-identity'));
  }
  // 上报事项本身仍可被两部门看到。
  assert.ok(postal.reports.some((r) => r.type === 'address_mismatch'));
});

test('沿包裹编号可查看资质核验、现场发现、部门去向和处置结论', async () => {
  const d = await loadDomain();
  const trace = traceParcel(d, 'P-9003');

  assert.equal(trace.qualification.customer_name, '湖南示例湘味食品有限公司');
  assert.equal(trace.qualification.verification.result, 'pass');
  assert.equal(trace.pickup.site.matches, null);
  assert.deepEqual(trace.field_findings.map((r) => r.report_id).sort(), ['R-301', 'R-302']);
  assert.ok(trace.field_findings.every((r) => r.reporter === '身份已另行封存'));

  const l401 = trace.department_routing.find((l) => l.lead_id === 'L-401');
  assert.equal(l401.status, 'INVESTIGATING');
  assert.equal(l401.jurisdiction, '长沙市望城区市场监督管理局（示例）');
  assert.match(l401.conclusion, /冻结/);
  assert.deepEqual(l401.supplements.map((s) => s.version), [1, 2]);
  assert.ok(l401.transfers[0].receipt_id.startsWith('RCP-XFER'));

  const l404 = trace.department_routing.find((l) => l.lead_id === 'L-404');
  assert.equal(l404.conclusion, '合并入 L-401 并案调查');

  // 未通过的食品明确停在哪个缺口。
  assert.equal(trace.gate.admitted, false);
  assert.equal(trace.gate.gap, 'SITE_MISMATCH');
});

test('已解除线索的追溯显示解除结论与复测依据', async () => {
  const d = await loadDomain();
  const trace = traceParcel(d, 'P-9002');
  const l403 = trace.department_routing.find((l) => l.lead_id === 'L-403');
  assert.equal(l403.conclusion, '已解除风险');
  assert.equal(trace.gate.admitted, true);
  assert.ok(trace.handovers.some((h) => h.temperature_celsius === 9.4));
  assert.equal(trace.handovers.at(-1).temperature_celsius, 6.0);
});

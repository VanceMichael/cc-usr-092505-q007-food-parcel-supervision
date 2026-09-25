// 食品寄递协同监管领域规则：
// 读取共享资料、执行资质核验/入网闸门/线索流转/期限与交接/字段最小授权等规则。

const REQUIRED_TOP_KEYS = [
  'actors', 'constraints', 'customers', 'departments', 'domain', 'facts',
  'leads', 'parcels', 'pickup_batches', 'reports', 'sample_id', 'verifications', 'version'
];

const CHECK_RESULTS = ['real_name_check', 'visual_inspection', 'security_check'];

// 入网闸门缺口，按核验顺序排列：资质码 → 场所 → 实名 → 验视 → 安检 → 温控 → 生效线索。
export const GATE_GAPS = [
  'CODE_TAMPERED',
  'SITE_MISMATCH',
  'REAL_NAME',
  'INSPECTION',
  'SECURITY',
  'TEMPERATURE',
  'ACTIVE_LEAD'
];

const CHECK_GAP = {
  real_name_check: 'REAL_NAME',
  visual_inspection: 'INSPECTION',
  security_check: 'SECURITY'
};

// 读取并检查仓库中的领域资料，包括关键引用完整性。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const keys = Object.keys(value).sort();
  const expected = [...REQUIRED_TOP_KEYS].sort();
  if (keys.join(',') !== expected.join(',')) {
    throw new Error('领域资料内容不完整');
  }
  if (value.version < 1 || value.actors.length < 2 || value.facts.length < 2 || value.constraints.length < 3) {
    throw new Error('领域资料内容不完整');
  }
  if (value.departments.length < 2) {
    throw new Error('领域资料内容不完整：缺少协作部门');
  }
  assertReferences(value);
  return value;
}

function assertReferences(d) {
  const customerIds = new Set(d.customers.map((c) => c.customer_id));
  const batchIds = new Set(d.pickup_batches.map((b) => b.batch_id));
  const parcelNos = new Set(d.parcels.map((p) => p.parcel_no));
  const reportIds = new Set(d.reports.map((r) => r.report_id));
  const leadIds = new Set(d.leads.map((l) => l.lead_id));
  const codes = new Set();

  for (const c of d.customers) {
    const qs = c.qualification_snapshot;
    if (codes.has(qs.verification_code)) {
      throw new Error(`核验码必须一码一核验：${qs.verification_code}`);
    }
    codes.add(qs.verification_code);
    if (!batchIds.has(qs.first_pickup_batch)) {
      throw new Error(`资质快照 ${qs.snapshot_id} 指向不存在的首次揽件批次`);
    }
  }

  for (const v of d.verifications) {
    if (!codes.has(v.verification_code)) {
      throw new Error(`核验记录 ${v.verification_code} 没有对应的资质快照`);
    }
    if (!batchIds.has(v.batch_id)) {
      throw new Error(`核验记录 ${v.verification_code} 指向不存在的批次`);
    }
  }

  for (const b of d.pickup_batches) {
    if (!customerIds.has(b.customer_id)) {
      throw new Error(`批次 ${b.batch_id} 指向不存在的客户`);
    }
    for (const parcelNo of b.parcels) {
      if (!parcelNos.has(parcelNo)) {
        throw new Error(`批次 ${b.batch_id} 含不存在的包裹 ${parcelNo}`);
      }
    }
  }

  for (const p of d.parcels) {
    if (!batchIds.has(p.batch_id)) {
      throw new Error(`包裹 ${p.parcel_no} 指向不存在的批次`);
    }
    if ((p.status === 'blocked') !== (p.blocked_gap !== null)) {
      throw new Error(`包裹 ${p.parcel_no} 的状态与缺口标记不一致`);
    }
  }

  for (const r of d.reports) {
    if (!parcelNos.has(r.parcel_no) || !batchIds.has(r.batch_id)) {
      throw new Error(`上报 ${r.report_id} 的包裹或批次不存在`);
    }
  }

  for (const l of d.leads) {
    for (const parcelNo of l.parcel_nos) {
      if (!parcelNos.has(parcelNo)) {
        throw new Error(`线索 ${l.lead_id} 指向不存在的包裹 ${parcelNo}`);
      }
    }
    for (const rid of l.related_report_ids) {
      if (!reportIds.has(rid)) {
        throw new Error(`线索 ${l.lead_id} 关联不存在的上报 ${rid}`);
      }
    }
    if (l.merged_into && !leadIds.has(l.merged_into)) {
      throw new Error(`线索 ${l.lead_id} 合并不存在的目标线索`);
    }
  }
}

// ---- 核验码：同一码扫码重试只形成一次核验；内容改变立即隔离 ----

// 模拟快递员扫码：返回一次既有核验（重试不新增），或在内容变化时形成隔离结论。
export function scanVerification(domain, code, { payload_hash, at }) {
  const snapshot = findSnapshotByCode(domain, code);
  if (!snapshot) {
    return { code, outcome: 'UNKNOWN_CODE', quarantined: true, gap: 'CODE_TAMPERED' };
  }
  let record = domain.verifications.find((v) => v.verification_code === code);

  if (!record) {
    record = {
      verification_code: code,
      batch_id: snapshot.first_pickup_batch,
      first_scan_at: at,
      payload_hash,
      result: payload_hash === snapshot.code_payload_hash ? 'pass' : 'quarantined',
      scan_attempts: 1
    };
    domain.verifications.push(record);
  } else {
    // 重试只累加扫码次数，不产生第二次核验。
    record.scan_attempts += 1;
    if (payload_hash !== record.payload_hash) {
      // 同一码内容相对首次扫码发生改变：立即隔离，原核验结论作废。
      record.result = 'quarantined';
      record.payload_hash = payload_hash;
      return {
        code,
        outcome: 'CONTENT_CHANGED',
        quarantined: true,
        verification_count: 1,
        scan_attempts: record.scan_attempts,
        gap: 'CODE_TAMPERED'
      };
    }
  }

  return {
    code,
    outcome: record.result === 'pass' ? 'ALREADY_VERIFIED' : 'QUARANTINED',
    quarantined: record.result !== 'pass',
    verification_count: 1,
    scan_attempts: record.scan_attempts,
    gap: record.result === 'pass' ? null : 'CODE_TAMPERED'
  };
}

function findSnapshotByCode(domain, code) {
  for (const c of domain.customers) {
    if (c.qualification_snapshot.verification_code === code) {
      return c.qualification_snapshot;
    }
  }
  return null;
}

// ---- 包裹入网闸门：进入寄递网络前确认当前证据上没有生效风险 ----

export function evaluateNetworkGate(domain, parcelNo) {
  const parcel = mustFind(domain.parcels, 'parcel_no', parcelNo, '包裹');
  const batch = mustFind(domain.pickup_batches, 'batch_id', parcel.batch_id, '批次');
  const customer = mustFind(domain.customers, 'customer_id', batch.customer_id, '客户');
  const snapshot = customer.qualification_snapshot;

  // 1) 核验码：一码一核验，内容必须与资质快照一致。
  const verification = domain.verifications.find((v) => v.verification_code === snapshot.verification_code);
  if (!verification || verification.result !== 'pass') {
    return gateDecision(parcelNo, false, 'CODE_TAMPERED', '核验码缺失、未通过或内容相对资质快照改变');
  }

  // 2) 实际揽件地必须是登记场所或已登记外设仓库。
  if (batch.pickup_site.matches === null) {
    return gateDecision(parcelNo, false, 'SITE_MISMATCH', `实际揽件地（${batch.pickup_site.address}）既非登记场所也非已登记外设仓库`);
  }

  // 3) 实名收寄、验视、安检逐项通过。
  for (const key of CHECK_RESULTS) {
    if (batch[key] !== 'pass') {
      return gateDecision(parcelNo, false, CHECK_GAP[key], checkLabel(key));
    }
  }

  // 4) 温控：交接测温超出要求区间且后续没有复测回稳的，仍是生效储运隐患。
  if (hasUnresolvedTemperatureExcursion(batch)) {
    return gateDecision(parcelNo, false, 'TEMPERATURE', '交接测温超出温控要求且未见复测恢复');
  }

  // 5) 当前证据上不得存在指向该包裹的生效线索。
  const active = activeLeadsForParcel(domain, parcelNo);
  if (active.length > 0) {
    return gateDecision(parcelNo, false, 'ACTIVE_LEAD', `存在生效线索：${active.map((l) => l.lead_id).join('、')}`);
  }

  return gateDecision(parcelNo, true, null, '当前证据无生效风险，可进入寄递网络');
}

function gateDecision(parcelNo, admitted, gap, reason) {
  return { parcel_no: parcelNo, admitted, gap, reason };
}

function checkLabel(key) {
  return {
    real_name_check: '实名收寄未通过',
    visual_inspection: '收寄验视未通过',
    security_check: '安全检查未通过'
  }[key];
}

function hasUnresolvedTemperatureExcursion(batch) {
  const range = batch.temperature_control.range_celsius;
  if (!range) return false;
  const [low, high] = range;
  let excursionSeen = false;
  for (const h of batch.handovers) {
    if (h.temperature_celsius === null) continue;
    const inRange = h.temperature_celsius >= low && h.temperature_celsius <= high;
    if (!inRange) {
      excursionSeen = true;
    } else if (excursionSeen) {
      // 后续交接复测回稳，运输环节隐患已解除。
      excursionSeen = false;
    }
  }
  return excursionSeen;
}

// 生效线索：调查中，或被合并进仍在调查的线索。已解除/关闭的不阻断入网。
export function activeLeadsForParcel(domain, parcelNo) {
  const investigating = new Map(
    domain.leads.filter((l) => l.status === 'INVESTIGATING').map((l) => [l.lead_id, l])
  );
  return domain.leads
    .filter((l) => l.parcel_nos.includes(parcelNo))
    .filter((l) => investigating.has(l.lead_id) || (l.merged_into && investigating.has(l.merged_into)));
}

// 资料中记录的包裹状态应与闸门实时判定一致。
export function checkParcelGateConsistency(domain) {
  const problems = [];
  for (const p of domain.parcels) {
    const gate = evaluateNetworkGate(domain, p.parcel_no);
    const expectedStatus = gate.admitted ? 'in_network' : 'blocked';
    if (p.status !== expectedStatus || p.blocked_gap !== gate.gap) {
      problems.push({
        parcel_no: p.parcel_no,
        recorded: { status: p.status, blocked_gap: p.blocked_gap },
        gate: { status: expectedStatus, blocked_gap: gate.gap }
      });
    }
  }
  return problems;
}

// ---- 线索流转：邮政先确认寄递事实，市场监管再作处置 ----

export const MARKET_DECISIONS = ['ACCEPT', 'TRANSFER', 'MERGE', 'RELEASED'];

export function validateLeadFlow(domain, leadId) {
  const lead = mustFind(domain.leads, 'lead_id', leadId, '线索');
  const errors = [];
  let postalConfirmed = false;
  const supplementVersions = new Set();

  for (const e of lead.events) {
    if (e.type === 'POSTAL_CONFIRMED') postalConfirmed = true;
    if (e.type === 'MARKET_DECISION' && !postalConfirmed) {
      errors.push(`事件 ${e.seq}：市场监管处置前缺少邮政寄递事实确认`);
    }
    if (e.type === 'MARKET_DECISION' && !MARKET_DECISIONS.includes(e.decision)) {
      errors.push(`事件 ${e.seq}：不支持的市场监管处置 ${e.decision}`);
    }
    if (e.type === 'SUPPLEMENT_APPENDED') {
      if (supplementVersions.has(e.version)) {
        errors.push(`事件 ${e.seq}：补充材料版本 ${e.version} 被覆盖，冻结后只允许追加`);
      }
      supplementVersions.add(e.version);
    }
    // 退回补正与跨辖区移交：携带原期限与交接回执，不重新计时。
    if (e.type === 'RETURNED_FOR_CORRECTION' || e.type === 'TRANSFERRED') {
      if (!e.receipt_id) {
        errors.push(`事件 ${e.seq}：${e.type} 缺少交接回执`);
      }
      if (e.preserved_due_at !== lead.origin_due_at) {
        errors.push(`事件 ${e.seq}：${e.type} 未沿用原始期限，部门切换不得重新计时`);
      }
    }
    if (e.type === 'TRANSFERRED' && e.to_jurisdiction !== lead.current_jurisdiction) {
      errors.push(`事件 ${e.seq}：跨辖区移交后当前辖区未更新为 ${e.to_jurisdiction}`);
    }
  }

  // 补充材料版本严格递增、只追加。
  lead.supplements.forEach((s, i) => {
    if (i > 0 && s.version <= lead.supplements[i - 1].version) {
      errors.push(`补充材料版本必须严格递增：${s.title}`);
    }
    if (!supplementVersions.has(s.version)) {
      errors.push(`补充材料 v${s.version} 缺少 SUPPLEMENT_APPENDED 事件`);
    }
  });

  if (lead.merged_into && lead.status !== 'MERGED') {
    errors.push('线索存在合并目标但状态不是 MERGED');
  }
  return { lead_id: leadId, valid: errors.length === 0, errors };
}

// 冻结后补充材料只追加版本；未冻结的线索直接拒绝修改。
export function appendSupplement(domain, leadId, { title, content_ref, added_at }) {
  const lead = mustFind(domain.leads, 'lead_id', leadId, '线索');
  if (!lead.frozen) {
    throw new Error(`线索 ${leadId} 未冻结，补充材料须在线索冻结后以追加版本提交`);
  }
  const version = lead.supplements.reduce((m, s) => Math.max(m, s.version), 0) + 1;
  const supplement = { version, title, content_ref, added_at };
  lead.supplements.push(supplement);
  lead.events.push({
    seq: lead.events.length + 1,
    type: 'SUPPLEMENT_APPENDED',
    at: added_at,
    version
  });
  return supplement;
}

// ---- 两部门字段最小授权；举报人身份另行保护 ----

const FIELD_SCOPE = {
  postal: {
    // 邮政职责：寄递事实、揽件批次、验视安检、温控交接、核验结论、上报事项。
    customer: ['customer_id', 'name'],
    snapshot: ['verification_code', 'code_payload_hash', 'first_pickup_batch'],
    batch: ['batch_id', 'customer_id', 'courier_id', 'pickup_site', 'picked_at', 'real_name_check', 'visual_inspection', 'security_check', 'temperature_control', 'parcels', 'handovers'],
    verification: ['verification_code', 'batch_id', 'first_scan_at', 'result', 'scan_attempts'],
    report: ['report_id', 'type', 'parcel_no', 'batch_id', 'detail', 'evidence_refs', 'reported_at'],
    lead: ['lead_id', 'source', 'parcel_nos', 'current_jurisdiction', 'status', 'postal_confirmation', 'events']
  },
  market: {
    // 市场监管职责：经营资质、场所仓库、线索证据、处置去向与期限。
    customer: ['customer_id', 'name', 'qualification_snapshot'],
    snapshot: ['snapshot_id', 'license_no', 'registered_premises', 'external_warehouses', 'verification_code', 'code_payload_hash', 'snapshot_at'],
    batch: ['batch_id', 'customer_id', 'pickup_site', 'picked_at', 'real_name_check', 'visual_inspection', 'security_check', 'temperature_control', 'parcels', 'handovers'],
    verification: ['verification_code', 'batch_id', 'first_scan_at', 'result'],
    report: ['report_id', 'type', 'parcel_no', 'batch_id', 'detail', 'evidence_refs', 'reported_at'],
    lead: null // 线索全字段对市场监管开放（处置主体）
  }
};

// 生成部门字段视图：只保留职责所需字段；任何视图都不含举报人身份封存信息。
export function departmentView(domain, dept) {
  const scope = FIELD_SCOPE[dept];
  if (!scope) throw new Error(`未知部门：${dept}`);

  const pick = (obj, allowed) => {
    if (allowed === null) return structuredClone(obj);
    const out = {};
    for (const k of allowed) {
      if (obj[k] !== undefined) out[k] = structuredClone(obj[k]);
    }
    return out;
  };

  const view = {
    department: dept,
    customers: domain.customers.map((c) => {
      const item = pick(c, scope.customer);
      // 两部门都需要资质快照的部分字段，具体可见范围由 scope.snapshot 裁剪。
      item.qualification_snapshot = pick(c.qualification_snapshot, scope.snapshot);
      return item;
    }),
    verifications: domain.verifications.map((v) => pick(v, scope.verification)),
    pickup_batches: domain.pickup_batches.map((b) => pick(b, scope.batch)),
    parcels: structuredClone(domain.parcels),
    // 举报人身份（reporter_sealed）对两部门均不出现在普通视图中，须走另行授权的身份解封流程。
    reports: domain.reports.map((r) => pick(r, scope.report)),
    leads: domain.leads.map((l) => scope.lead === null ? structuredClone(l) : pick(l, scope.lead))
  };
  return view;
}

// ---- 沿包裹编号全链路追溯 ----

export function traceParcel(domain, parcelNo) {
  const parcel = mustFind(domain.parcels, 'parcel_no', parcelNo, '包裹');
  const batch = mustFind(domain.pickup_batches, 'batch_id', parcel.batch_id, '批次');
  const customer = mustFind(domain.customers, 'customer_id', batch.customer_id, '客户');
  const snapshot = customer.qualification_snapshot;
  const verification = domain.verifications.find((v) => v.verification_code === snapshot.verification_code) || null;
  const reports = domain.reports
    .filter((r) => r.parcel_no === parcelNo)
    .map((r) => ({ report_id: r.report_id, type: r.type, detail: r.detail, reported_at: r.reported_at, reporter: '身份已另行封存' }));
  const leads = domain.leads
    .filter((l) => l.parcel_nos.includes(parcelNo))
    .map((l) => ({
      lead_id: l.lead_id,
      status: l.status,
      frozen: l.frozen,
      jurisdiction: l.current_jurisdiction,
      merged_into: l.merged_into,
      origin_due_at: l.origin_due_at,
      postal_confirmation: l.postal_confirmation,
      decisions: l.events.filter((e) => e.type === 'MARKET_DECISION'),
      transfers: l.events.filter((e) => e.type === 'TRANSFERRED'),
      supplements: l.supplements.map((s) => ({ version: s.version, title: s.title })),
      conclusion: leadConclusion(l)
    }));
  const gate = evaluateNetworkGate(domain, parcelNo);

  return {
    parcel_no: parcelNo,
    recorded_status: parcel.status,
    qualification: {
      customer_id: customer.customer_id,
      customer_name: customer.name,
      snapshot_id: snapshot.snapshot_id,
      license_no: snapshot.license_no,
      registered_premises: snapshot.registered_premises,
      external_warehouses: snapshot.external_warehouses,
      verification: verification ? {
        result: verification.result,
        first_scan_at: verification.first_scan_at,
        scan_attempts: verification.scan_attempts
      } : null
    },
    pickup: {
      batch_id: batch.batch_id,
      site: batch.pickup_site,
      real_name_check: batch.real_name_check,
      visual_inspection: batch.visual_inspection,
      security_check: batch.security_check,
      temperature_control: batch.temperature_control
    },
    handovers: batch.handovers,
    field_findings: reports,
    department_routing: leads,
    gate
  };
}

function leadConclusion(l) {
  if (l.status === 'RELEASED') return '已解除风险';
  if (l.status === 'MERGED') return `合并入 ${l.merged_into} 并案调查`;
  if (l.status === 'CLOSED') return '已结案';
  const last = [...l.events].reverse().find((e) => e.type === 'MARKET_DECISION');
  if (l.frozen) return `调查中（已冻结，最近处置：${last ? last.decision : '待处置'}）`;
  return `调查中（最近处置：${last ? last.decision : '待处置'}）`;
}

function mustFind(list, key, value, label) {
  const item = list.find((x) => x[key] === value);
  if (!item) throw new Error(`${label} ${value} 不存在`);
  return item;
}

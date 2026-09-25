# 食品寄递协同监管

衔接湖南省邮政管理与市场监管两部门：食品协议客户经营资质核验、寄递全过程交接，以及跨部门风险线索的受理、移交、合并与解除。

## 领域资料

- `contracts/domain.schema.json`：共享资料结构契约
- `fixtures/domain.json`：不含真实个人信息的端到端示例（2 家客户、4 个包裹、3 条快递员上报、4 条线索）
- `src/domain.js`：领域规则（无外部依赖，可在 Node 中直接引用）

参与方：快递员、食品协议客户、邮政管理人员、市场监管人员。举报人身份在资料中以封存引用（`reporter_sealed.vault_ref`）单独保存，不进入任一部门的常规字段视图。

## 已固化的业务规则

1. **资质快照与核验码**：首次揽件前保存经营许可、登记场所、外设仓库、核验码及码内容哈希；一码对应一次核验。
2. **扫码规则**：同一核验码反复扫码只累加扫码次数、不产生第二次核验；码内容相对资质快照或首次扫码改变，立即隔离（缺口 `CODE_TAMPERED`）。
3. **场所核验**：实际揽件地必须等于登记场所或已登记外设仓库，否则包裹停在 `SITE_MISMATCH`，仅退回包裹不移送证据不再可能让线索从其他网点继续流通。
4. **揽件批次**：实名收寄、收寄验视、安全检查结果逐项记录；未通过分别停在 `REAL_NAME`/`INSPECTION`/`SECURITY`。
5. **温控与交接**：冷藏/冷冻要求随批次记录，每次运输交接测温并回执；超温且后续无复测回稳的，停在 `TEMPERATURE`。
6. **快递员上报**：地址不符、包装异常、储运隐患三类，证据随上报保存，举报人身份另行封存。
7. **流转顺序**：邮政部门先确认寄递事实（`POSTAL_CONFIRMED`），市场监管随后作出受理（ACCEPT）、移交（TRANSFER）、合并（MERGE）或解除（RELEASED）。
8. **冻结与追加**：线索冻结后补充材料只能以严格递增版本追加，既有版本不可覆盖。
9. **期限不重新计时**：退回补正、跨辖区移交都携带原期限（`preserved_due_at = origin_due_at`）和交接回执，部门切换不重置时限。
10. **入网闸门**：包裹进入寄递网络前实时确认当前证据上没有生效风险（未解除的调查中线索，含已合并进入主线索的情形，阻断入网：`ACTIVE_LEAD`）。
11. **最小授权**：邮政视图含寄递/批次/交接字段而不含许可证号；市场监管视图含资质/场所/线索全字段而不含快递员工号；两部门视图均不含举报人身份。
12. **包裹编号追溯**：沿 `parcel_no` 可查看资质核验、现场发现、部门去向、移交回执、补充版本与处置结论；未通过的包裹明确标注停在哪个缺口。

## 主要函数

`src/domain.js` 导出：

- `parseDomain(raw)`：解析并校验结构与引用完整性
- `scanVerification(domain, code, { payload_hash, at })`：扫码重试/篡改判定
- `evaluateNetworkGate(domain, parcelNo)`：入网闸门，返回 `{ admitted, gap, reason }`
- `checkParcelGateConsistency(domain)`：资料记录状态与闸门判定是否一致
- `validateLeadFlow(domain, leadId)`：流转顺序、追加版本、期限与回执校验
- `appendSupplement(domain, leadId, material)`：冻结线索追加补充版本
- `departmentView(domain, 'postal' | 'market')`：部门字段最小授权视图
- `traceParcel(domain, parcelNo)`：包裹全链路追溯

## 开发命令

- 运行测试：`npm test`
- 编译或构建：`npm run build`

上述命令只读取仓库内文件，不连接外部业务服务。

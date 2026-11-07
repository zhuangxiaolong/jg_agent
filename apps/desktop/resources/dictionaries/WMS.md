# WMS 内置数据字典（基础版）

本文件是随精工 Agent 发布的 WMS 基础字段索引，用于帮助 Agent 识别常见仓储业务对象。项目实际表结构、ERP/WCS 接口字段、库位策略和客户扩展以目标仓库及用户导入的项目数据字典为准。

## WMS_MATERIAL 物料

| 字段 | 含义 | 常见类型 |
|---|---|---|
| MaterialCode | 物料编码 | 字符串 |
| MaterialName | 物料名称 | 字符串 |
| Specification | 规格型号 | 字符串 |
| Unit | 库存单位 | 字符串 |
| BatchControl | 是否批次管理 | 布尔 |
| Enabled | 是否启用 | 布尔 |

## WMS_LOCATION 库位

| 字段 | 含义 | 常见类型 |
|---|---|---|
| LocationCode | 库位编码 | 字符串 |
| WarehouseCode | 仓库编码 | 字符串 |
| AreaCode | 库区编码 | 字符串 |
| LocationType | 库位类型 | 枚举 |
| Status | 库位状态 | 枚举 |

## WMS_STOCK 库存

| 字段 | 含义 | 常见类型 |
|---|---|---|
| MaterialCode | 物料编码 | 字符串 |
| LocationCode | 库位编码 | 字符串 |
| LotNo | 批次号 | 字符串 |
| Qty | 可用数量 | 数值 |
| LockQty | 锁定数量 | 数值 |
| UpdatedAt | 更新时间 | 时间 |

## 说明

- WMS 项目需结合 ERP、WCS、条码和库存事务接口确认实际字段。
- FIFO、FEFO、批次、序列号和库存锁定规则必须以项目规范与验收口径为准。
- 本字典内容仅作检索参考，不是数据库执行脚本。

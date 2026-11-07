# MES6 内置数据字典（基础版）

本文件是随精工 Agent 发布的 MES6 基础字段索引，用于帮助 Agent 识别常见业务对象。项目实际实体、SqlSugar 映射、组织字段和客户扩展以目标仓库及用户导入的项目数据字典为准。

## IMES_PRODUCTION_ORDER 生产工单

| 字段 | 含义 | 常见类型 |
|---|---|---|
| Id | 主键 | UUID/字符串 |
| OrderNo | 工单号 | 字符串 |
| ProductCode | 产品编码 | 字符串 |
| PlanQty | 计划数量 | 数值 |
| Status | 工单状态 | 枚举 |
| OrganizeId | 组织标识 | 字符串 |

## IMES_PRODUCT_OPERATION 产品过站

| 字段 | 含义 | 常见类型 |
|---|---|---|
| Id | 过站记录主键 | UUID/字符串 |
| SerialNumber | 序列号 | 字符串 |
| OperationCode | 工序编码 | 字符串 |
| WorkCenterCode | 工作中心 | 字符串 |
| Result | 过站结果 | 枚举 |
| OccurredAt | 发生时间 | 时间 |

## IMES_WORK_STATION 工作站

| 字段 | 含义 | 常见类型 |
|---|---|---|
| StationCode | 站点编码 | 字符串 |
| StationName | 站点名称 | 字符串 |
| ResourceCode | 资源编码 | 字符串 |
| Enabled | 是否启用 | 布尔 |
| OrganizeId | 组织标识 | 字符串 |

## 说明

- MES6 常见 `IMES.*` 项目、`IMES.sln`、`.NET 10` 和 SqlSugar 源码核心。
- 过站主流程属于实时高风险区域，修改前应确认查询次数、事务边界和多数据库方言。
- 本字典内容仅作检索参考，不是数据库执行脚本。

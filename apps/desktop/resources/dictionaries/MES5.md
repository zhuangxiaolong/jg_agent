# MES5 内置数据字典（基础版）

本文件是随精工 Agent 发布的 MES5 基础字段索引，用于帮助 Agent 识别常见业务对象。项目实际表结构、客户扩展字段和存储过程以目标仓库及用户导入的项目数据字典为准。

## SFCS_WORK_ORDER 工单

| 字段 | 含义 | 常见类型 |
|---|---|---|
| MO_NUMBER | 制令/工单号 | VARCHAR2 |
| PART_NO | 料号 | VARCHAR2 |
| QTY | 工单数量 | NUMBER |
| STATUS | 工单状态 | VARCHAR2 |
| START_DATE | 开工日期 | DATE |
| CLOSE_DATE | 完工日期 | DATE |

## SFCS_SERIAL_NUMBER 序列号

| 字段 | 含义 | 常见类型 |
|---|---|---|
| SERIAL_NUMBER | 产品序列号 | VARCHAR2 |
| MO_NUMBER | 关联工单号 | VARCHAR2 |
| ROUTE_CODE | 工艺路线 | VARCHAR2 |
| OPERATION_CODE | 当前工序 | VARCHAR2 |
| STATUS | 序列号状态 | VARCHAR2 |

## SFCS_OPERATION 工序

| 字段 | 含义 | 常见类型 |
|---|---|---|
| OPERATION_CODE | 工序编码 | VARCHAR2 |
| OPERATION_NAME | 工序名称 | VARCHAR2 |
| WORK_CENTER | 工作中心 | VARCHAR2 |
| REPORT_FLAG | 是否允许报工 | NUMBER/CHAR |
| PASS_QTY | 合格数量 | NUMBER |
| FAIL_QTY | 不良数量 | NUMBER |

## 说明

- MES5 主数据库通常为 Oracle，历史模块可能同时存在 SQL Server 实现。
- 传统项目常见 `JZ.IMS.*` 命名空间、`JZ.IMS.sln` 和 `netcoreapp3.1`。
- 本字典内容仅作检索参考，不是数据库执行脚本。

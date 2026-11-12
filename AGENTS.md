# 全局自定义指令 — MES / WMS / 前端项目自动识别

## 沟通约定（所有项目通用）

- **始终用中文回复**，代码注释、提交信息也用中文；保留必要的英文技术名词。
- **输出先结论后细节**，尽量简洁。
- 提交信息格式：一句话概括改动，可附 Jira 链接，例如：`修复设备过站报错"Value cannot be null.(Parameter 'source')"`

## 第一步：识别项目类型（按仓库指纹，不看目录路径）

用户维护多代 MES、WMS 和前端系统。处理代码任务前，先检查仓库根目录，按以下指纹识别当前仓库类型：

| 指纹（按可靠度排序） | MES6 (iMES) | MES5 (JZ.IMS) |
| --- | --- | --- |
| csproj 的 TargetFramework | `net10.0` / `net10.0-windows` | `netcoreapp3.1`（个别 2.2） |
| 解决方案文件 | `IMES.sln` | `JZ.IMS.sln` |
| 项目/命名空间前缀 | `IMES.*` | `JZ.IMS.*`（特例 `IMS.JWT`） |
| 入口项目 | `IMES.Web.Entry/` | `JZ.IMS.WebApi/` |
| ORM 核心 | 源码项目 `IMES.SqlSugar.Core/` | NuGet 包 `CorePackage/JZ.IMS.Core.*.nupkg` |
| 数据库配置键 | `SqlConnection` + `DbType` | `DbOpion` + `ErpDbOpion`（键名拼写就是 DbOpion） |

前端项目按仓库根目录指纹识别为“前端”：根目录 `package.json` 的依赖或构建脚本包含 React、Vue、Angular、Svelte、Solid、Next、Nuxt、Vite、Webpack、Rollup、Parcel、Astro 等框架/构建工具，或根目录存在 `vite.config.*`、`next.config.*`、`nuxt.config.*`、`vue.config.*`、`svelte.config.*`、`angular.json` 等配置。只用仓库根目录作为前端整体识别依据，避免 monorepo 内部前端子包覆盖明确的 MES/WMS 后端指纹；若同一仓库存在明确 MES5、MES6 或 WMS 指纹，以后端系统为准。

指纹不明确时，再读 `README.md`、`AGENTS.md`、入口项目、appsettings、命名空间和项目引用链综合判断；**仍无法判断时只问一个最小确认问题，不要猜**。识别后不要混用 MES5/MES6 的模式（例如在 MES5 里用 Furion 特性，或在 MES6 里手写 Dapper 事务）。前端项目先读取根目录 `package.json`、构建配置和现有组件/状态管理实现，再决定框架写法。

## 第二步：以仓库原有代码为准（最重要原则）

识别版本后，**不要凭记忆或通用惯例写代码，先分析项目原有代码，遵循它的既有规范**。代码规范、命名习惯、分层方式、异常处理、DTO 结构、校验方式、DI 方式、配置读取方式、日志写法、SQL 写法、测试写法，都以仓库现有实现为事实标准。**文档（包括本文件）和通用经验只做参考，与现有代码冲突时以代码为准。**动手前做到：

1. **看同类文件再写新文件**：新增或修改 Service / Repository / 实体 / 控制器前，先找同目录（或同业务模块）里 2～3 个现有同类实现，提炼出该项目的真实习惯再编码：类结构、基类/接口选择、依赖注入方式、方法命名、参数与返回值风格（如统一返回包装类型）、异常处理和日志写法。
2. **实体与 SQL 跟随现状**：先看目标表的现有实体如何映射（特性、列名大小写、基类）、现有查询用什么方式（Lambda / 手写 SQL / 存储过程）以及是哪种数据库方言，保持一致；不要引入项目里没有的写法。
3. **注释密度、命名语言（中文/英文）**：与被改文件的现状保持一致，不多不少。
4. **配置与常量**：新配置项跟随 appsettings 里既有的节点组织方式和命名风格。
5. **不确定就搜**：某个模式在项目里是否有先例，用搜索确认（如搜基类名、特性名、工具类名），有先例就复用；没有先例就先问用户或选最保守的实现。
6. **写法不一致时**：同一仓库内多个写法并存时，优先跟随该模块**最新、最常用、最完整**的实现。
7. **改公共代码前查影响面**：基类、公共工具、拦截器等被跨模块引用，改之前搜索所有派生类和调用点。

## MES6（iMES）— 架构事实

制造执行系统第 6 代 API 后端。技术栈：**.NET 10 + Furion 框架 + SqlSugar ORM + Redis Cluster + RabbitMQ + SignalR + Nacos + Serilog**。多数据库支持（PostgreSQL / Oracle / SQL Server，由配置 `DbType` 驱动；不同客户部署可能不同，以当前仓库的 appsettings 为准）。

- 入口：`IMES.Web.Entry`；全局服务注册：`IMES.Web.Core/Startup.cs`；ORM/多库/AOP 配置：`IMES.SqlSugar.Core/Startup.cs`。
- 按业务域组织的 monorepo，每个业务域通常包含五个子项目：

```text
<域名>/
├── IMES.<域名>.Application   # API 控制器（Furion 动态 API）、业务编排
├── IMES.<域名>.Domain        # 核心业务逻辑（Service）
├── IMES.<域名>.Models        # 数据库实体（SugarTable 映射）
├── IMES.<域名>.ViewModels    # DTO / 请求响应契约
└── IMES.<域名>.Enums         # 业务枚举
```

- 主要业务域：**ProductionManagement**（生产管理，核心：过站/工单/维修/返工/报废）、CraftConfig、ProductPlan、FactoryBuild、ProductConfig、Reel、Burn、Barrel、Andon、RedCard、Resource、TeamHandover、DataSync、Sys、Base、Common（命名空间 `IWMS.Common`，历史遗留）。
- **Service 动态路由模式**：`Domain/BaseServices/` 放抽象基类与通用逻辑，`Domain/BizServices/` 放具体实现；业务服务用 `[ClassCategory(Module = "...", Code = "...")]` 特性标记，经 `Application/Services/` 下的 `*ServiceTypeMap.cs` 按编码路由到实现。新增业务类型遵循此模式。
- **新增业务域**：按现有模式补齐 `Application/Domain/Models/ViewModels/Enums` 五个子项目，并在 `IMES.Web.Core` 和入口项目完成引用与注册。
- **事务**：由 `SqlSugarUnitOfWorkFilter` AOP 自动管理（异常自动回滚），Service 里一般不手动 BeginTran/Commit。
- **多组织**：`db.Aop.DataExecuting` 拦截器自动填充 `OrganizeId` 等字段，实体继承 `BaseMes` 即获得。
- **缓存**：SqlSugar `.WithCache(...)` + Redis；配置了 `IsAutoRemoveDataCache = true`，写操作自动清缓存。

### MES6 已知的坑（勿重蹈）

- **多数据库方言**：不要写死某一种数据库的方言 SQL（`NVL`、`SYSDATE`、`ROWNUM`、`TOP`、`GETDATE()` 等）。优先用 SqlSugar Lambda 让 ORM 生成方言；必须裸 SQL 时按 `db.CurrentConnectionConfig.DbType` 做分支。ERP 库通常独立于主库类型（如主库 PG 时 ERP 仍是 SQL Server），改前确认。
- **数据库在远程时，性能瓶颈通常是串行网络往返**（N 次查询 × RTT），不是单条慢查询。优化方向是减少查询次数（合并、批量取数）。
- **禁止用 `db.CopyNew()` 并行化带 `WithCache` 的查询**——缓存上下文不一致会导致缓存失效，反而更慢。
- SqlSugar 对某些复杂 Lambda（如复杂 `Contains`）可能翻译不正确或低效，改动查询后确认生成的 SQL。
- `BaseDDD/` 是旧版遗留目录，新代码不要往里加。
- 过站主流程（`ProductOperation`）是产线实时调用的高风险区域，改完要确认查询次数没有增加。

## MES5（JZ.IMS）— 架构事实

制造执行系统第 5 代 API 后端（启动日志标识“iMES5.0系统启动”）。技术栈：**.NET Core 3.1 + ASP.NET Core（无 Furion）+ SqlSugar 5.1.4 + Dapper + Autofac + AutoMapper + CSRedis + Quartz + MongoDB（IoT 数据）**。主数据库 **Oracle**，兼容 SQL Server。

- 传统三层架构（非按业务域拆项目）：

```text
JZ.IMS.sln
├── JZ.IMS.IServices / JZ.IMS.Services      # 全局服务层，内部按业务目录组织（SFCS/SMT/WMS/Andon 等约 27 个模块）
├── JZ.IMS.IRepository                       # 仓储接口
├── JZ.IMS.Repository.Oracle                 # 主仓储实现（Oracle + Dapper）
├── JZ.IMS.Repository.SqlServer              # 副仓储实现
├── JZ.IMS.Models / ViewModels / MongoModels # 实体与 DTO
├── JZ.IMS.WebApi                            # 入口（Autofac 容器）
├── JZ.IMS.Admin                             # 后台管理（netcoreapp2.2）
├── JZ.IMS.Job                               # Quartz 定时任务
├── IMS.JWT                                  # JWT 认证
├── CorePackage/                             # JZ.IMS.Core NuGet 包（基础设施，非源码）
└── Doc/                                     # 对接文档（SCADA/钉钉/工资核算等）
```

- **Repository 模式**：泛型基类 `BaseExRepository<T, TKey>`，底层 Dapper，大量手写 Oracle 方言 SQL。
- **事务是手动管理的**：`using (var tran = dbConnection.BeginTransaction()) { ...; tran.Commit(); }`，改代码必须保持事务边界完整。
- **实体映射用 DataAnnotations**（`[Table("XXX")]` + `[Key]`），不是 SugarTable；属性名通常直接是大写列名（如 `TENANT_ID`）。
- DTO 映射用 AutoMapper；DI 用 Autofac 按约定批量注册；分布式锁 RedLock.net；分布式 ID 用 Yitter.IdGenerator。
- 数据库配置在 `JZ.IMS.WebApi/appsettings.json`：`DbOpion`（主库）、`ErpDbOpion`（受 `UseErp` 开关）、`MongoDBHost`（受 `UseMongoDB` 开关）；`JZ.IMS.WebApi/Config/*.json` 也是配置重点。
- 常见外部集成：ERP、U9、金蝶 E10、MongoDB、Redis、Nacos、钉钉、PLM、WMS、SCADA。

### MES5 API 打包约定

- 所有 MES5 项目的 API 打包都按此规则执行：打包前必须先执行 `dotnet build JZ.IMS.sln`，构建通过后再从 `JZ.IMS.WebApi/bin/Debug/netcoreapp3.1/` 选取指定文件打成 zip。
- zip 只包含以下 14 个文件：`JZ.IMS.WebApi.Views.dll`、`JZ.IMS.WebApi.dll`、`JZ.IMS.WebApi.exe`、`JZ.IMS.WebApi.xml`、`JZ.IMS.Repository.Oracle.dll`、`JZ.IMS.Services.dll`、`JZ.IMS.IRepository.dll`、`JZ.IMS.IServices.dll`、`JZ.IMS.Job.dll`、`JZ.IMS.MongoModels.dll`、`JZ.IMS.ViewModels.dll`、`JZ.IMS.ViewModels.xml`、`JZ.IMS.Models.dll`、`JZ.IMS.Models.xml`。
- 不要把 `.pdb`、`appsettings*.json`、`deps.json`、`runtimeconfig*.json` 或其它未列出的文件放入该 zip，除非用户另行明确要求。

### MES5 已知的坑

- 基础设施 `JZ.IMS.Core` 在 NuGet 包里没有源码，其内部行为只能黑盒对待，不要试图改包内代码。
- .NET Core 3.1 对应 C# 8，不要用新语法（record、`init`、模式匹配增强等）。
- 手写 SQL 是 Oracle 方言，改动时保持方言一致；涉及 SqlServer 仓储时同步检查另一份实现。
- 历史代码若使用静态辅助类、ServiceLocator 或旧式注入方式，优先兼容现状，非必要不大改；尊重老项目的控制器/仓储/服务约定，不要强行套 MES6 的 DDD 分层。

## 通用工程约定（所有项目都适用）

- 先搜索，再修改；优先复用仓库已有实现。
- 只改需求相关代码，避免无关重构和大范围格式化；确需重构先征得用户同意。
- 构建验证：改动后至少 `dotnet build <解决方案>.sln` 确认编译通过。
- 变更后说明影响范围、风险和验证方式。
- 这些是生产制造系统，产线实时调用：任何改动优先保守，明确影响面后再动手；性能敏感路径改完要评估查询次数与事务范围的变化。

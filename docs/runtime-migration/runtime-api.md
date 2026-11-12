# Runtime 适配器接口

```ts
type RuntimeKind = 'jinggong' | 'codex';

interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  checkRuntime(): Promise<RuntimeHealth>;
  start(): Promise<void>;
  startSession(cwd: string): Promise<string>;
  resumeSession(threadId: string, cwd: string): Promise<string>;
  sendTurn(threadId: string, prompt: string, cwd: string, imagePaths?: string[]): Promise<void>;
  cancelRun(threadId: string): Promise<void>;
  close(): Promise<void>;
}
```

Adapter 屏蔽底层协议差异；事件至少包含 `threadId`、事件类型、文本和请求 ID。能力检测必须返回 `available`、`compatible`、版本、能力版本和诊断信息。未实现的能力必须报告为不支持，不能在 UI 或协议层伪造审批、沙箱或工具执行结果。

Codex Adapter 复用仓库已有 App Server stdio 实现。Jinggong Adapter 复用协议适配层，但可执行文件必须来自独立 Rust Fork。Manifest、上游提交、Fork 补丁摘要和初始化 User-Agent 分别校验，禁止以 Codex 二进制改名代替。

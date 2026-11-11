import { useEffect, useState } from 'react';
import type { PluginDetail, PluginManagerApi, PluginRecord, PluginSkillRecord } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './plugin-manager.css';

const profileId = 'plugin-manager';
const statusNames: Record<PluginRecord['status'], string> = { imported: '已导入', installed: '已安装', disabled: '已停用', error: '异常', unavailable: '不可用' };
const trustNames: Record<PluginRecord['trustStatus'], string> = { untrusted: '未信任', reviewed: '已检查', trusted: '已信任', revoked: '已撤销' };
const healthNames: Record<PluginDetail['mcpServers'][number]['healthStatus'], string> = { unknown: '未检查', healthy: '可用', unhealthy: '连接失败', 'auth-required': '需要认证', unavailable: '运行时未接入' };

export function PluginManagerPanel({ api }: { api: PluginManagerApi }) {
  const [plugins, setPlugins] = useState<PluginRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [preview, setPreview] = useState<{ skill: PluginSkillRecord; content: string } | null>(null);
  const [sourceType, setSourceType] = useState<'zip' | 'folder'>('zip');
  const [sourcePath, setSourcePath] = useState('');
  const [mcpSecrets, setMcpSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh(nextId = selectedId) {
    const rows = await api.listPlugins();
    setPlugins(rows);
    const id = rows.some(plugin => plugin.id === nextId) ? nextId : rows[0]?.id ?? '';
    setSelectedId(id);
    if (id) setDetail(await api.getPluginDetail(id));
    else setDetail(null);
  }

  useEffect(() => { void refresh('').catch(reason => setError(safeError(reason))); }, [api]);

  async function run(label: string, work: () => Promise<unknown>, success: string, refreshAfter = true) {
    setBusy(label); setError(''); setNotice('');
    try {
      await work();
      if (refreshAfter) await refresh();
      setNotice(success);
    } catch (reason) { setError(safeError(reason)); }
    finally { setBusy(''); }
  }

  async function select(id: string) {
    setSelectedId(id); setDetail(null); setPreview(null); setError('');
    try { setDetail(await api.getPluginDetail(id)); }
    catch (reason) { setError(safeError(reason)); }
  }

  async function importPlugin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let warnings: string[] = [];
    await run('import', async () => {
      const result = await api.importPlugin({ path: sourcePath.trim(), sourceType });
      warnings = result.warnings;
      await refresh(result.plugin.id);
      setSourcePath('');
    }, '插件已导入并完成解析。', false);
    if (warnings.length) setNotice(`插件已导入。${warnings.join('；')}`);
  }

  async function importCodexPlugins() {
    let summary = '';
    await run('import-codex', async () => {
      const result = await api.importCodexPlugins();
      const skipped = result.skipped.length ? `，${result.skipped.length} 个插件未导入` : '';
      summary = `已扫描 ${result.scanned} 个 Codex 插件，导入或更新 ${result.imported.length} 个${skipped}。`;
    }, 'Codex 插件扫描完成。');
    if (summary) setNotice(summary);
  }

  async function browseSource() {
    setError('');
    try {
      const selected = await api.selectPluginPath(sourceType);
      if (selected) setSourcePath(selected);
    } catch (reason) { setError(safeError(reason)); }
  }

  async function showSkill(skill: PluginSkillRecord) {
    setBusy(`skill:${skill.id}`); setError(''); setPreview(null);
    try {
      const result = await api.previewSkill(skill.id);
      setPreview({ skill: result.skill, content: result.content });
    } catch (reason) { setError(safeError(reason)); }
    finally { setBusy(''); }
  }

  function trust(plugin: PluginRecord, scope: 'install' | 'execute_mcp') {
    if (!detail || detail.plugin.id !== plugin.id || detail.review.contentHash !== plugin.contentHash) {
      setError('插件审阅资料已过期，请刷新后重新检查。');
      return;
    }
    const action = scope === 'execute_mcp' ? '允许该插件启动 MCP Server 并执行其服务端代码' : '允许该插件安装到精工管理的 Codex Profile';
    if (!window.confirm(`已显示并检查插件审阅资料（内容 Hash ${detail.review.contentHash}）。确认信任“${plugin.name}”并${action}？`)) return;
    void run(`trust:${scope}`, () => api.trustPlugin(plugin.id, scope), scope === 'execute_mcp' ? '已记录 MCP 执行信任。' : '已记录安装信任。');
  }

  function secretInputKey(serverId: string, reference: string): string { return `${serverId}\0${reference}`; }
  function saveMcpSecret(serverId: string, reference: string) {
    const key = secretInputKey(serverId, reference);
    const secret = mcpSecrets[key] ?? '';
    if (!secret) { setError('请输入 MCP 凭据。'); return; }
    void run(`mcp-credential:${serverId}:${reference}`, async () => {
      await api.saveMcpCredential(serverId, reference, secret);
      setMcpSecrets(current => ({ ...current, [key]: '' }));
    }, 'MCP 凭据已加密保存到本机 DPAPI Vault。');
  }

  const hasMcp = !!detail?.mcpServers.length;
  const binding = detail?.runtimeBindings.find(item => item.profileId === profileId && item.runtimeKind === 'codex');

  return <section className="plugin-manager" aria-label="插件管理">
    <header className="plugin-manager-heading"><div><h3>插件管理</h3><p>导入 Codex 插件、检查能力并管理受控 Codex 配置。</p></div><div className="plugin-manager-heading-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void importCodexPlugins()}>{busy === 'import-codex' ? '扫描中…' : '从 Codex 加载插件'}</button><button type="button" className="icon-button" aria-label="刷新插件列表" title="刷新插件列表" disabled={!!busy} onClick={() => void run('refresh', () => refresh(), '插件列表已刷新。', false)}><Icon name="refresh" /></button></div></header>
    <div className="plugin-manager-note"><Icon name="shield" /><p>插件默认不受信任。启用或安装不会运行 Hooks；Skills 仅在 Codex Runtime 中按所选 Profile 提供。Profile 插件集合与会话快照关联，用户级 Skills/Marketplace 仍可能被 Codex 发现。</p></div>

    <form className="plugin-import-form" onSubmit={event => void importPlugin(event)}>
      <label>来源类型<select value={sourceType} disabled={!!busy} onChange={event => setSourceType(event.target.value as typeof sourceType)}><option value="zip">ZIP 压缩包</option><option value="folder">本地目录</option></select></label>
      <label className="plugin-path-field">插件路径<input value={sourcePath} disabled={!!busy} onChange={event => setSourcePath(event.target.value)} required placeholder={sourceType === 'zip' ? '选择或输入 .zip 文件完整路径' : '选择或输入插件目录完整路径'} /></label>
      <button type="button" className="secondary-button" disabled={!!busy} onClick={() => void browseSource()}><Icon name="file" />浏览</button>
      <button type="submit" className="primary-button" disabled={!!busy || !sourcePath.trim()}><Icon name="plus" />{busy === 'import' ? '导入中…' : '导入插件'}</button>
    </form>

    {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}
    {notice && <div className="settings-notice" role="status"><Icon name="check" />{notice}</div>}

    <div className="plugin-manager-layout">
      <nav className="plugin-list" aria-label="已导入插件">
        {!plugins.length && <p className="settings-empty">尚未导入插件。</p>}
        {plugins.map(plugin => <button key={plugin.id} type="button" className={`plugin-list-row${selectedId === plugin.id ? ' selected' : ''}`} onClick={() => void select(plugin.id)} disabled={!!busy}>
          <span className="plugin-list-title"><Icon name="box" /><strong>{plugin.name}</strong></span>
          <small>{plugin.version} · {statusNames[plugin.status]} · {trustNames[plugin.trustStatus]}</small>
        </button>)}
      </nav>

      <div className="plugin-detail">
        {!detail && <p className="settings-empty">选择一个插件查看详情。</p>}
        {detail && <>
          <header className="plugin-detail-heading"><div><h4>{detail.plugin.name}</h4><p>{detail.plugin.description || '未提供说明'}</p></div><span className={`plugin-status plugin-status-${detail.plugin.trustStatus}`}>{trustNames[detail.plugin.trustStatus]}</span></header>
          <dl className="plugin-metadata"><div><dt>版本</dt><dd>{detail.plugin.version}</dd></div><div><dt>来源</dt><dd>{detail.plugin.sourceType}</dd></div><div><dt>能力</dt><dd>{detail.skills.length} 个 Skill · {detail.mcpServers.length} 个 MCP · Hooks 不执行（P1）</dd></div><div><dt>SHA-256</dt><dd>{detail.plugin.contentHash}</dd></div></dl>
          <section className="plugin-subsection plugin-review" aria-label="信任审阅资料"><h5>信任前审阅</h5><p className="plugin-muted">以下资料来自受控 Store 的重新扫描，已脱敏；确认信任前请核对来源、Manifest、命令和资源清单。审阅 Hash 变化后必须重新检查。</p><dl className="plugin-metadata"><div><dt>来源路径</dt><dd>{detail.review.sourcePath || '未提供'}</dd></div><div><dt>Manifest</dt><dd>{detail.review.manifest.format} · {detail.review.manifest.path} · {detail.review.manifest.sha256}</dd></div><div><dt>Hooks</dt><dd>{detail.review.hooks.length ? detail.review.hooks.join('、') : '未发现（P0 不执行）'}</dd></div><div><dt>可执行资源</dt><dd>{detail.review.executableResources.length ? detail.review.executableResources.join('、') : '未发现'}</dd></div></dl><details><summary>查看脱敏 Manifest</summary><pre className="plugin-review-json">{JSON.stringify(detail.review.manifest.raw, null, 2)}</pre></details>{detail.review.diagnostics.length > 0 && <ul className="plugin-review-diagnostics">{detail.review.diagnostics.map(item => <li key={`${item.code}:${item.message}`}><strong>{item.severity === 'error' ? '错误' : '警告'} · {item.code}</strong> {item.message}</li>)}</ul>}<div className="plugin-review-skill-list">{detail.review.skills.map(skill => <article key={skill.id}><strong>{skill.name}</strong><small>{skill.skillFile} · {skill.contentHash}</small><span>{skill.resources.length ? `资源：${skill.resources.map(resource => `${resource.kind}:${resource.relativePath}`).join('、')}` : '无关联资源'}</span></article>)}</div></section>
          <div className="plugin-actions">
            <button type="button" className="secondary-button" disabled={!!busy || detail.plugin.trustStatus === 'revoked'} onClick={() => trust(detail.plugin, 'install')}>信任安装</button>
            {hasMcp && <button type="button" className="secondary-button" disabled={!!busy || detail.plugin.trustStatus === 'revoked'} onClick={() => trust(detail.plugin, 'execute_mcp')}>信任 MCP 执行</button>}
            <button type="button" className="secondary-button" disabled={!!busy || detail.plugin.trustStatus !== 'trusted'} onClick={() => void run('install', () => api.installForCodex(detail.plugin.id, profileId), '插件已安装到精工管理的 Codex Profile。')}>{busy === 'install' ? '安装中…' : binding?.installState === 'installed' ? '重新安装' : '安装到 Codex'}</button>
            <button type="button" className="secondary-button" disabled={!!busy || detail.plugin.trustStatus !== 'trusted'} onClick={() => void run('toggle', () => api.enablePlugin(detail.plugin.id, !detail.plugin.enabled), detail.plugin.enabled ? '插件已停用。' : '插件已启用。')}>{detail.plugin.enabled ? '停用' : '启用'}</button>
            {binding?.installState === 'installed' && <button type="button" className="danger-button" disabled={!!busy} onClick={() => void run('uninstall', () => api.uninstallFromCodex(detail.plugin.id, profileId), '已从精工管理的 Codex Profile 卸载。')}>卸载</button>}
            <button type="button" className="text-button" disabled={!!busy} onClick={() => void run('validate', () => api.validatePlugin(detail.plugin.id), '插件检查已完成。')}>重新检查</button>
          </div>
          {!!detail.plugin.author?.name && <p className="plugin-muted">作者：{detail.plugin.author.name}</p>}
          <section className="plugin-subsection"><h5>Skills <span>{detail.skills.length}</span></h5>
            {!detail.skills.length && <p className="plugin-muted">没有发现 Skill。</p>}
            {detail.skills.map(skill => <div className="plugin-skill-row" key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description || '未提供说明'}</p><small>{skill.skillDir}</small></div><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void showSkill(skill)}>预览</button></div>)}
          </section>
          <section className="plugin-subsection"><h5>MCP Server <span>{detail.mcpServers.length}</span></h5>
            {detail.mcpServers.map(server => <article className="plugin-mcp-row" key={server.id}><div><strong>{server.serverName}</strong><small>{server.transport} · {healthNames[server.healthStatus]} · {server.credentialRefs.length ? `凭据 ${server.configuredCredentialRefs?.length ?? 0}/${server.credentialRefs.length} 项` : '不需要凭据'} · {server.enabled ? '管理状态：已启用' : '管理状态：已停用'}</small><code>{mcpEndpoint(server)}</code><details><summary>查看脱敏 Server 配置</summary><pre className="plugin-review-json">{JSON.stringify(server.configRedacted, null, 2)}</pre></details>{server.lastError && <p className="plugin-muted">{safeError(server.lastError)}</p>}
              {server.credentialRefs.map(reference => <label className="plugin-mcp-credential" key={reference}>{reference}<input type="password" autoComplete="new-password" value={mcpSecrets[secretInputKey(server.id, reference)] ?? ''} onChange={event => setMcpSecrets(current => ({ ...current, [secretInputKey(server.id, reference)]: event.target.value }))} placeholder={server.configuredCredentialRefs?.includes(reference) ? '已配置；输入新值可替换' : '输入凭据'} disabled={!!busy} /><button type="button" className="secondary-button" disabled={!!busy || !(mcpSecrets[secretInputKey(server.id, reference)] ?? '')} onClick={() => saveMcpSecret(server.id, reference)}>保存凭据</button>{server.configuredCredentialRefs?.includes(reference) && <button type="button" className="text-button" disabled={!!busy} onClick={() => void run(`mcp-clear:${server.id}:${reference}`, () => api.clearMcpCredential(server.id, reference), '已从 DPAPI Vault 删除 MCP 凭据。')}>清除</button>}</label>)}
            </div><div className="plugin-mcp-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void run(`mcp-enable:${server.id}`, () => api.setMcpServerEnabled(server.id, !server.enabled), server.enabled ? 'MCP Server 管理状态已停用。' : 'MCP Server 管理状态已启用。')}>{server.enabled ? '停用' : '启用'}</button><button type="button" className="secondary-button" disabled title="当前版本未接入 MCP 连接与工具发现">运行时未接入</button></div></article>)}
            <p className="plugin-warning">当前版本尚未接入 MCP Server 实际连接、健康检查和工具发现；此处仅展示脱敏配置与审阅信息。</p>
            {detail.mcpServers.some(server => server.credentialRefs.length) && <p className="plugin-warning">凭据通过主进程 DPAPI Vault 加密保管；Codex MCP 运行时注入尚未接入，不能视为可运行。</p>}
          </section>
          {detail.review.mcpServers.length > 0 && <section className="plugin-subsection"><h5>MCP 信任审阅</h5>{detail.review.mcpServers.map(server => <article className="plugin-mcp-row" key={server.id}><div><strong>{server.name} · {server.transport}</strong><pre className="plugin-review-json">{JSON.stringify(server.redactedConfig, null, 2)}</pre><p className="plugin-muted">凭据变量只显示引用名：{[...Object.keys(server.envRefs ?? {}), ...Object.keys(server.httpHeaderRefs ?? {})].join('、') || '无'}</p></div></article>)}</section>}
          <section className="plugin-subsection"><h5>运行时绑定</h5>{binding ? <p className="plugin-muted">Codex Profile：{profileId} · {binding.installState}{binding.lastError ? ` · ${safeError(binding.lastError)}` : ''}</p> : <p className="plugin-muted">尚未安装到精工管理的 Codex Profile。</p>}</section>
        </>}
      </div>
    </div>

    {preview && <div className="plugin-preview-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null); }}><section className="plugin-preview" role="dialog" aria-modal="true" aria-labelledby="plugin-preview-title"><header><div><h4 id="plugin-preview-title">{preview.skill.name}</h4><p>{preview.skill.description}</p></div><button type="button" className="icon-button" aria-label="关闭预览" title="关闭预览" onClick={() => setPreview(null)}><Icon name="close" /></button></header><pre>{preview.content}</pre></section></div>}
  </section>;
}

function safeError(value: unknown): string {
  const source = value instanceof Error ? value.message : String(value);
  return source
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[已脱敏]')
    .replace(/([?&](?:key|token|secret|password|api[_-]?key)=)[^&#\s]+/gi, '$1[已脱敏]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, '$1[已脱敏]');
}

function mcpEndpoint(server: PluginDetail['mcpServers'][number]): string {
  const config = server.configRedacted;
  if (server.transport === 'stdio' && 'command' in config) return `stdio · ${config.command} · ${config.args?.length ?? 0} 个参数（不展开）`;
  if ('url' in config && typeof config.url === 'string') {
    try { const url = new URL(config.url); return `${url.protocol}//${url.host}${url.pathname}`; }
    catch { return 'HTTP 地址不可用'; }
  }
  return '配置不可用';
}

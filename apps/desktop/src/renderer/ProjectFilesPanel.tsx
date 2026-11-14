import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { GitFileEntry, Project } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { ProjectFilePreview } from './ProjectFilePreview';

interface Node { name: string; path: string; children: Node[]; file?: GitFileEntry }
interface Menu { file: GitFileEntry; x: number; y: number }

function treeOf(files: GitFileEntry[]): Node[] {
  const roots: Node[] = [];
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let level = roots;
    let parent = '';
    parts.forEach((name, index) => {
      const path = parent ? `${parent}/${name}` : name;
      let node = level.find(item => item.name === name);
      if (!node) { node = { name, path, children: [] }; level.push(node); }
      if (index === parts.length - 1) node.file = file;
      else level = node.children;
      parent = path;
    });
  }
  const sort = (items: Node[]) => { items.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name)); items.forEach(item => sort(item.children)); };
  sort(roots);
  return roots;
}

export function ProjectFilesPanel({ project, sessionId, initialPath, onError }: { project: Project; sessionId?: string; initialPath?: string; onError: (error: unknown) => void }) {
  const api = window.jinggong;
  const target = sessionId || { projectId: project.id };
  const [files, setFiles] = useState<GitFileEntry[]>([]);
  const [selected, setSelected] = useState('');
  const [preview, setPreview] = useState<{ path: string; absolutePath: string; content: string } | null>(null);
  const [previewExpanded, setPreviewExpanded] = useState(true);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => treeOf(files), [files]);
  function relativePath(value: string): string {
    const root = project.path.replace(/\\/g, '/').replace(/\/$/, '');
    const normalized = value.trim().replace(/\\/g, '/');
    if (normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return normalized.slice(root.length + 1);
    return normalized.replace(/^\.\//, '');
  }

  async function loadFiles() {
    setLoading(true);
    try { setFiles(await api.getProjectFiles(target)); }
    catch (error) { onError(error); }
    finally { setLoading(false); }
  }
  async function openFile(file: string) {
    setSelected(file);
    try { setPreview(await api.readProjectFile(target, file)); setPreviewExpanded(true); }
    catch (error) { setPreview(null); onError(error); }
  }
  useEffect(() => { setCollapsed({}); void loadFiles(); }, [project.id, sessionId]);
  useEffect(() => { if (initialPath) void openFile(relativePath(initialPath)); }, [initialPath, project.path]);

  function render(nodes: Node[], depth = 0): ReactElement[] {
    return nodes.map(node => {
      if (node.file) {
        const status = node.file.status;
        const tone = status ? (status === 'A' || status === '?' ? 'added' : status === 'D' ? 'deleted' : 'modified') : '';
        return <button type="button" key={node.path} className={`project-file-row ${tone} ${selected === node.path ? 'selected' : ''}`} style={{ paddingLeft: 10 + depth * 14 }} title={node.path} onClick={() => void openFile(node.path)} onContextMenu={event => { event.preventDefault(); setMenu({ file: node.file!, x: event.clientX, y: event.clientY }); }}><Icon name="file" /><span>{node.name}</span>{status && <b>{status}</b>}</button>;
      }
      const isCollapsed = collapsed[node.path] !== false;
      return <div key={node.path}><button type="button" className="project-file-row project-folder-row" style={{ paddingLeft: 8 + depth * 14 }} aria-expanded={!isCollapsed} onClick={() => setCollapsed(value => ({ ...value, [node.path]: value[node.path] === false }))}><Icon name="chevron" className={isCollapsed ? '' : 'expanded'} /><Icon name="folder" /><span>{node.name}</span></button>{!isCollapsed && render(node.children, depth + 1)}</div>;
    });
  }
  return <section className="project-files-panel" aria-label="项目文件列表" onClick={() => menu && setMenu(null)}>
    <div className="project-files-heading"><strong>{project.name} 文件</strong><button type="button" className="icon-button" title="刷新项目文件" aria-label="刷新项目文件" disabled={loading} onClick={() => void loadFiles()}><Icon name="refresh" /></button></div>
    <code className="project-files-root" title={project.path}>{project.path}</code>
    {loading && <div className="inspector-empty"><span>正在读取项目文件…</span></div>}
    {!loading && !files.length && <div className="inspector-empty"><strong>项目暂无可显示文件</strong><p>Git 已跟踪或未忽略的文件会显示在这里。</p></div>}
    {!loading && !!files.length && <div className="project-files-tree">{render(tree)}</div>}
    {preview && <ProjectFilePreview file={preview} expanded={previewExpanded} onToggle={() => setPreviewExpanded(value => !value)} onReveal={() => void api.revealProjectFile(target, preview.path).catch(onError)} />}
    {menu && <div className="file-context-menu project-file-menu" role="menu" style={{ left: Math.min(menu.x, Math.max(8, window.innerWidth - 250)), top: Math.min(menu.y, Math.max(8, window.innerHeight - 120)) }} onClick={event => event.stopPropagation()}><div className="file-context-heading">{menu.file.path}</div><button role="menuitem" onClick={() => { void openFile(menu.file.path); setMenu(null); }}><Icon name="file" />查看文件</button><button role="menuitem" onClick={() => { void api.revealProjectFile(target, menu.file.path).catch(onError); setMenu(null); }}><Icon name="folder" />在资源管理器打开</button></div>}
  </section>;
}

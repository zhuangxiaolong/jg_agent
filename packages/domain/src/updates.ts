export const DEFAULT_UPDATE_URL = 'https://github.com/zhuangxiaolong/jg_agent';

export function updateFeed(input: string): { url: string; feed: { provider: 'github'; owner: string; repo: string } | { provider: 'generic'; url: string } } {
  const value = input.trim();
  if (value.length > 2000) throw new Error('更新地址过长');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('更新地址必须为不含认证信息和查询参数的 HTTPS 地址');
  if (url.hostname === 'github.com') {
    const match = /^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match || url.port) throw new Error('请输入 GitHub 仓库首页地址');
    return { url: `https://github.com/${match[1]}/${match[2]}`, feed: { provider: 'github', owner: match[1], repo: match[2] } };
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return { url: url.href, feed: { provider: 'generic', url: url.href } };
}

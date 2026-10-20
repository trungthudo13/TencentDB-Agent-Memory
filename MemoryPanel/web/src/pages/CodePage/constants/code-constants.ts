export type { SubView, ViewMode, StatusFilter, ScopeTab } from '@/lib/asset-common';
export { formatShortTime } from '@/lib/asset-common';

export function isValidGitHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !!url.hostname && url.pathname !== '/' && !url.username && !url.password && !url.search && !url.hash && !/\s/.test(raw);
  } catch { return false; }
}
export function isValidGitSshUrl(raw: string): boolean {
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s]+$/.test(raw)) return true;
  try {
    const url = new URL(raw);
    return url.protocol === 'ssh:' && !!url.hostname && url.pathname !== '/' && !url.password && !url.search && !url.hash && (!url.username || /^[a-zA-Z0-9._-]+$/.test(url.username)) && !/\s/.test(raw);
  } catch { return false; }
}

/**
 * 从 Git URL 提取可读的仓库名称。
 *
 * repo_name 可能为空（旧数据），此时回退到 URL 会显得很长。
 * 这里从 URL 中提取最后两段路径作为 `namespace/repo` 格式：
 *   https://gitlab.example.com/namespace/repo.git → namespace/repo
 *   https://github.com/org/project.git → org/project
 *   https://git.woa.com/group/sub/repo.git → sub/repo
 * 如果只有一段路径，直接返回该段（去掉 .git 后缀）。
 * 解析失败时返回原始 URL（保底）。
 */
export function formatRepoName(repoName: string, repoUrl: string): string {
  if (repoName && !repoName.startsWith('http')) return repoName;
  const url = repoName || repoUrl;
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
    if (segments.length === 1) return segments[0];
  } catch {
    // fallback
  }
  return url;
}

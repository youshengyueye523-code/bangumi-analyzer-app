export const PRIVACY_EVENT = 'analyzer-personal-privacy-changed';

export async function governanceRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || '请求未完成，请读取当前状态后重试。');
  return result as T;
}

export function privacyChanged(version: number, safePath: string): void {
  try { window.localStorage.setItem(PRIVACY_EVENT, `${version}:${Date.now()}`); } catch { /* same-tab reset still happens */ }
  window.location.replace(safePath);
}

export const hideWork = (id: number) => governanceRequest<{dataVersion:number}>(`/api/subjects/${id}/user-hide`, {method:'PUT'});

export async function downloadFullData(url: string): Promise<void> {
  let response = await fetch(url, {cache:'no-store'});
  if (response.status === 403) {
    if (!window.confirm('完整备份或 JSON 包含已隐藏作品和来源原文。确认下载完整数据？')) return;
    response = await fetch(url, {cache:'no-store', headers:{'X-Analyzer-Private-Intent':'full-data'}});
  }
  if (!response.ok) throw new Error('下载未完成。');
  const href = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = /filename="([\w.-]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ?? 'bangumi-analyzer';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

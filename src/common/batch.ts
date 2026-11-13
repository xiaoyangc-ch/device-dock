/**
 * 流式结果的推送预算。
 *
 * 全盘搜索命中几万条时，渲染层每接一批都要重建数组（O(n²)），
 * 而最终只展示第一页——超出预算的部分没必要过 IPC。
 */
export function takeBatch<T>(pending: T[], sent: number, max: number): T[] {
  if (sent >= max) return []
  return pending.slice(0, max - sent)
}

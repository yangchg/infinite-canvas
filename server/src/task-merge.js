// Browser blob URLs are ephemeral representations of the same immutable attachment.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key,
    value.storageKey && ['content', 'dataUrl', 'url'].includes(key) ? '' : comparable(value[key])]));
  return value;
}
export const sameCanvasValue = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
const equal = sameCanvasValue;
export function canvasContent(project) {
  const { category = '通用', description = '', nodes = [], connections = [], chatSessions = [], activeChatId = null, backgroundMode = 'lines', showImageInfo = false, viewport = { x: 0, y: 0, k: 1 } } = project;
  return { category, description, nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo, viewport };
}

// Merge only disjoint edits. Never choose a winner for concurrent edits to the same field.
export function mergeCanvas(base, local, remote) {
  if (equal(remote, base) || equal(local, remote)) return structuredClone(local);
  if (equal(local, base)) return structuredClone(remote);
  if ([base, local, remote].every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    const result = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = mergeCanvas(base[key], local[key], remote[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if ([base, local, remote].every((v) => Array.isArray(v) && v.every((item) => item && typeof item.id === 'string'))) {
    const maps = [base, local, remote].map((items) => new Map(items.map((item) => [item.id, item])));
    return [...new Set([...local, ...remote, ...base].map((item) => item.id))]
      .map((id) => mergeCanvas(...maps.map((map) => map.get(id)))).filter(Boolean);
  }
  throw Object.assign(new Error('画布与后台结果修改了同一内容，请保留当前草稿后刷新比较；生成结果已保存在任务中。'), { statusCode: 409 });
}

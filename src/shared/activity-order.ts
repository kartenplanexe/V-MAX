export function orderWithoutActivity(order: [string, string][], removed: string): [string, string][] {
  const before = order.filter(edge => edge[1] === removed).map(edge => edge[0]);
  const after = order.filter(edge => edge[0] === removed).map(edge => edge[1]);
  const edges = order.filter(edge => !edge.includes(removed));
  for (const a of before) for (const b of after)
    if (a !== b && !edges.some(edge => edge[0] === a && edge[1] === b)) edges.push([a, b]);
  return edges;
}

export function validActivityOrder(ids: string[], order: [string, string][]) {
  const pending = new Set(ids);
  if (order.some(([a, b]) => a === b || !pending.has(a) || !pending.has(b))) return false;
  while (pending.size) {
    const roots = [...pending].filter(id => !order.some(([a, b]) => b === id && pending.has(a)));
    if (!roots.length) return false;
    roots.forEach(id => pending.delete(id));
  }
  return true;
}

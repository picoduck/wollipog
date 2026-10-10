interface HeapSnapshot {
  snapshot: { meta: { node_fields: string[]; edge_fields: string[];
    node_types: [string[], ...unknown[]]; edge_types: [string[], ...unknown[]] } };
  nodes: number[];
  edges: number[];
  strings: string[];
}

/** Inspect Chromium's graph, excluding weak edges. No browser remote objects are held by this
 * analysis. Keep the path's edge labels: they distinguish JS callbacks/state from native owners. */
export function previewRetainers(raw: string) {
  const heap = JSON.parse(raw) as HeapSnapshot;
  const meta = heap.snapshot.meta;
  const width = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const nodeCount = heap.nodes.length / width;
  const field = (index: number, key: string) => heap.nodes[index * width + meta.node_fields.indexOf(key)]!;
  const name = (index: number) => heap.strings[field(index, "name")]!;
  const type = (index: number) => meta.node_types[0][field(index, "type")]!;
  if (!meta.node_fields.includes("detachedness")) throw new Error("Chromium heap lacks detachedness");
  const targets: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (type(index) === "native" && field(index, "detachedness") === 2 &&
        /^<div class="session-detail preview"/.test(name(index))) targets.push(index);
  }
  if (targets.length === 0) return { detachedPreviewRoots: 0, retainerPath: [] };
  // A forward BFS gives the shortest strong path from the GC root. Store one parent per node;
  // retaining every reverse edge of a large heap would needlessly multiply the probe's memory.
  const starts = new Uint32Array(nodeCount);
  let edgeOffset = 0;
  for (let index = 0; index < nodeCount; index++) {
    starts[index] = edgeOffset;
    edgeOffset += field(index, "edge_count") * edgeWidth;
  }
  const parents = new Int32Array(nodeCount).fill(-1);
  const parentEdges = new Int32Array(nodeCount).fill(-1);
  const queue = [0];
  parents[0] = 0;
  const target = targets[0]!;
  for (let cursor = 0; cursor < queue.length && parents[target] === -1; cursor++) {
    const source = queue[cursor]!;
    const end = starts[source]! + field(source, "edge_count") * edgeWidth;
    for (let offset = starts[source]!; offset < end; offset += edgeWidth) {
      const edgeType = meta.edge_types[0][heap.edges[offset + meta.edge_fields.indexOf("type")]!]!;
      if (edgeType === "weak") continue;
      const destination = heap.edges[offset + meta.edge_fields.indexOf("to_node")]! / width;
      if (parents[destination] !== -1) continue;
      parents[destination] = source;
      parentEdges[destination] = offset;
      queue.push(destination);
    }
  }
  const retainerPath: Array<{ from: string; edgeType: string; edge: string; to: string }> = [];
  if (parents[target] === -1) throw new Error("Detached preview has no strong GC-root path");
  for (let destination = target; destination !== 0;) {
    const source = parents[destination]!;
    const offset = parentEdges[destination]!;
    const edgeType = meta.edge_types[0][heap.edges[offset + meta.edge_fields.indexOf("type")]!]!;
    const edgeValue = heap.edges[offset + meta.edge_fields.indexOf("name_or_index")]!;
    retainerPath.unshift({ from: `${type(source)} ${name(source)}`, edgeType,
      edge: edgeType === "element" || edgeType === "hidden" ? String(edgeValue) : heap.strings[edgeValue]!,
      to: `${type(destination)} ${name(destination)}` });
    destination = source;
  }
  return { detachedPreviewRoots: targets.length, retainerPath };
}

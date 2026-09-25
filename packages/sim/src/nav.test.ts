import { describe, expect, it } from 'vitest';
import { createCollisionWorld } from './collision.js';
import { NavGraph, CoverPointSet, buildTacticalContent, validateTacticalContent, type NavNode } from './nav.js';
import * as fx from './math/fixed.js';

const v = (x: number, z: number) => ({ x: fx.fromInt(x), y: 0, z: fx.fromInt(z) });
const world = createCollisionWorld([], { minX: fx.fromInt(-20), minY: 0, minZ: fx.fromInt(-20), maxX: fx.fromInt(20), maxY: fx.fromInt(20), maxZ: fx.fromInt(20) });

function graph(): NavGraph {
  const nodes: NavNode[] = [
    { id: 0, pos: v(0, 0), neighbors: [1, 2] },
    { id: 1, pos: v(1, 1), neighbors: [0, 3] },
    { id: 2, pos: v(1, -1), neighbors: [0, 3] },
    { id: 3, pos: v(2, 0), neighbors: [1, 2] },
  ];
  return new NavGraph(nodes);
}

describe('NavGraph', () => {
  it('returns the same route and stable lower-id tie break', () => {
    const nav = graph();
    expect(nav.route(0, 3)).toEqual(nav.route(0, 3));
    expect(nav.route(0, 3)?.nodes).toEqual([0, 1, 3]);
  });
  it('uses a recovery route when the preferred edge is blocked', () => {
    expect(graph().route(0, 3, [[0, 1]])?.nodes).toEqual([0, 2, 3]);
  });
});

describe('CoverPointSet', () => {
  const covers = new CoverPointSet([
    { id: 2, pos: v(3, 0), exposure: 0, tags: 1 },
    { id: 1, pos: v(2, 0), exposure: 0, tags: 1 },
  ]);
  it('orders candidates deterministically and respects occupancy', () => {
    expect(covers.select(world, v(0, 0), v(10, 0))?.id).toBe(1);
    expect(covers.select(world, v(0, 0), v(10, 0), [1])?.id).toBe(2);
  });
});

describe('generated tactical content', () => {
  it('contains only valid connected points', () => {
    const content = buildTacticalContent(world, [v(-10, 0), v(0, 0), v(10, 0), v(0, 10)]);
    expect(validateTacticalContent(content.graph, content.covers, world)).toBe(true);
    for (const node of content.graph.nodes) {
      expect(content.graph.route(content.graph.nodes[0]!.id, node.id)).not.toBeNull();
    }
  });
});

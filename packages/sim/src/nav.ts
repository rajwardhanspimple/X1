import * as fx from './math/fixed.js';
import { pointInSolid, type BoxFx, type CollisionWorld } from './collision.js';
import type { Vec3Fx } from './state.js';

export interface NavNode { id: number; pos: Vec3Fx; neighbors: readonly number[]; }
export interface NavRoute { nodes: number[]; cost: number; }
export interface CoverPoint { id: number; pos: Vec3Fx; exposure: number; tags: number; }

function distance(a: Vec3Fx, b: Vec3Fx): number {
  const dx = fx.toInt(fx.abs((a.x - b.x) | 0));
  const dz = fx.toInt(fx.abs((a.z - b.z) | 0));
  return dx * dx + dz * dz;
}

/** Integer-cost graph search. Node ids and neighbor order are the tie-breakers. */
export class NavGraph {
  readonly nodes: readonly NavNode[];
  private readonly byId: Map<number, NavNode>;
  constructor(nodes: readonly NavNode[]) {
    this.nodes = [...nodes].sort((a, b) => a.id - b.id);
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
  }
  route(start: number, goal: number, blockedEdges: readonly [number, number][] = []): NavRoute | null {
    if (!this.byId.has(start) || !this.byId.has(goal)) return null;
    const blocked = new Set(blockedEdges.map(([a, b]) => `${a}:${b}`));
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    const open = new Set<number>([start]);
    dist.set(start, 0);
    while (open.size > 0) {
      let current = -1;
      let best = Number.MAX_SAFE_INTEGER;
      for (const id of [...open].sort((a, b) => a - b)) {
        const d = dist.get(id) ?? Number.MAX_SAFE_INTEGER;
        if (d < best) { best = d; current = id; }
      }
      if (current < 0) break;
      open.delete(current);
      if (current === goal) break;
      const node = this.byId.get(current)!;
      for (const next of [...node.neighbors].sort((a, b) => a - b)) {
        if (blocked.has(`${current}:${next}`) || !this.byId.has(next)) continue;
        const cost = best + distance(node.pos, this.byId.get(next)!.pos);
        const old = dist.get(next);
        if (old === undefined || cost < old || (cost === old && current < (prev.get(next) ?? Number.MAX_SAFE_INTEGER))) {
          dist.set(next, cost); prev.set(next, current); open.add(next);
        }
      }
    }
    if (!dist.has(goal)) return null;
    const nodes = [goal];
    while (nodes[0] !== start) nodes.unshift(prev.get(nodes[0]!)!);
    return { nodes, cost: dist.get(goal)! };
  }
  nearest(pos: Vec3Fx): number {
    let best = this.nodes[0]?.id ?? 0;
    let bestDistance = Number.MAX_SAFE_INTEGER;
    for (const node of this.nodes) {
      const d = distance(pos, node.pos);
      if (d < bestDistance || (d === bestDistance && node.id < best)) { best = node.id; bestDistance = d; }
    }
    return best;
  }
  position(id: number): Vec3Fx { return this.byId.get(id)?.pos ?? { x: 0, y: 0, z: 0 }; }
}

export class CoverPointSet {
  readonly points: readonly CoverPoint[];
  constructor(points: readonly CoverPoint[]) { this.points = [...points].sort((a, b) => a.id - b.id); }
  valid(world: CollisionWorld, point: CoverPoint): boolean {
    const p = point.pos;
    return p.x > world.bounds.minX && p.x < world.bounds.maxX && p.z > world.bounds.minZ && p.z < world.bounds.maxZ && !pointInSolid(world, p);
  }
  select(world: CollisionWorld, from: Vec3Fx, threat: Vec3Fx, occupied: readonly number[] = []): CoverPoint | null {
    const used = new Set(occupied);
    let best: CoverPoint | null = null;
    let bestScore = Number.MAX_SAFE_INTEGER;
    for (const point of this.points) {
      if (used.has(point.id) || !this.valid(world, point)) continue;
      const d = distance(from, point.pos);
      const exposure = distance(point.pos, threat) + point.exposure;
      const score = d * 4 + exposure;
      if (score < bestScore || (score === bestScore && point.id < (best?.id ?? Number.MAX_SAFE_INTEGER))) { best = point; bestScore = score; }
    }
    return best;
  }
}

export function validateTacticalContent(graph: NavGraph, covers: CoverPointSet, world: CollisionWorld): boolean {
  return graph.nodes.every((n) => n.pos.x > world.bounds.minX && n.pos.x < world.bounds.maxX && n.pos.z > world.bounds.minZ && n.pos.z < world.bounds.maxZ && !pointInSolid(world, n.pos)) && covers.points.every((p) => covers.valid(world, p));
}

export function buildTacticalContent(world: CollisionWorld, points: readonly Vec3Fx[]): { graph: NavGraph; covers: CoverPointSet } {
  const valid = points.filter((p) => p.x > world.bounds.minX && p.x < world.bounds.maxX && p.z > world.bounds.minZ && p.z < world.bounds.maxZ && !pointInSolid(world, p));
  const nodes: NavNode[] = valid.map((pos, id) => ({ id, pos: { ...pos }, neighbors: [] }));
  for (const node of nodes) {
    const candidates = nodes.filter((other) => other.id !== node.id).map((other) => ({ id: other.id, d: distance(node.pos, other.pos) })).sort((a, b) => a.d - b.d || a.id - b.id).slice(0, 3);
    (node as { neighbors: number[] }).neighbors = candidates.map((c) => c.id);
  }
  const covers = new CoverPointSet(valid.map((pos, id) => ({ id, pos: { ...pos }, exposure: id % 4, tags: 1 })));
  return { graph: new NavGraph(nodes), covers };
}

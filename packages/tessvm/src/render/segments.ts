// Batch only two-point strokes as quads; longer strokes need Entry's miter joins.
import { Mesh, MeshGeometry, Texture, type Container } from 'pixi.js';
import type { Stroke } from '../runtime/model.ts';
import { quadIndices, writeQuads } from './segment-geometry.ts';

// Keep small runs on the path renderer because a mesh costs more below this count.
export const SEGMENT_FLOOR = 16;

// Reserve space so growing strokes do not rebuild the buffer immediately.
const FIRST_ROOM = 256;

export { isSegment } from './segment-geometry.ts';

export class SegmentBatch {
  private readonly parent: Container;
  private mesh: Mesh | null = null;
  private positions: Float32Array = new Float32Array(0);
  private room = 0;
  private drawn = 0;

  constructor(parent: Container) {
    this.parent = parent;
  }

  set(
    pieces: Stroke[],
    from: number,
    to: number,
    thickness: number,
    color: number,
    alpha: number,
  ): void {
    if (to - from > this.room) {
      this.remake(to - from);
    }
    const positions = this.positions;
    const count = writeQuads(pieces, from, to, thickness, positions);
    // Collapse leftover vertices to one point so a shorter frame cannot draw stale geometry.
    if (this.drawn > count) {
      positions.fill(0, count * 8, this.drawn * 8);
    }
    this.drawn = count;
    const mesh = this.mesh!;
    mesh.geometry.getBuffer('aPosition').update();
    mesh.tint = color;
    mesh.alpha = alpha;
    mesh.visible = true;
  }

  hide(): void {
    if (this.mesh) {
      this.mesh.visible = false;
    }
  }

  // Destroy old geometry when replacing the mesh.
  private remake(count: number): void {
    const room = Math.max(count, this.room * 2, FIRST_ROOM);
    const positions = new Float32Array(room * 8);
    const uvs = new Float32Array(room * 8);
    const indices = quadIndices(room);
    const mesh = new Mesh({
      geometry: new MeshGeometry({ positions, uvs, indices }),
      texture: Texture.WHITE,
    });
    // These buffers belong to this batch; Mesh.destroy leaves shared geometry alone.
    mesh.once('destroyed', () => mesh.geometry.destroy(true));
    this.mesh?.destroy({ children: true });
    this.parent.addChild(mesh);
    this.mesh = mesh;
    this.positions = positions;
    this.room = room;
    this.drawn = 0;
  }
}

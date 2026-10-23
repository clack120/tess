// Keep Entry's stage coordinates and apply sharpness through renderer resolution.
import {
  Application,
  Assets,
  CanvasTextMetrics,
  Color,
  TextStyle,
  ColorMatrixFilter,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
} from 'pixi.js';
import { stage, type Entity, type Picture, type Stroke, type Target } from '../runtime/model.ts';
import type { Renderer } from '../runtime/engine.ts';
import { buildMask } from '../collision/mask-image.ts';
import type { AlphaMask } from '../collision/mask.ts';
import { Overlay, type TableLike } from './overlay.ts';
import { entityBounds, type Rect } from '../collision/detect.ts';
import { fillParts } from './fill.ts';
import { isSegment, SegmentBatch, SEGMENT_FLOOR } from './segments.ts';
import {
  FULLSCREEN_CANVAS_WIDTH,
  MAX_SHARPNESS,
  MIN_CANVAS_WIDTH,
  MIN_TEXT_SHARPNESS,
  svgBudgetScale,
  svgSharpness,
  textSharpness,
} from './sharpness.ts';

interface Ink {
  color: number;
  // Eight-digit hex carries alpha; other supported colors are opaque.
  alpha: number;
}

// Ignore invalid colors like canvas does; keep alpha separately so eight-digit colors remain transparent.
const colorCache = new Map<string, Ink | null>();

type StampSprite = Sprite & { __baked?: string };

interface Baked {
  url: string;
  src: string;
  resolution: number;
}

// Reference-count rasterized vectors because PIXI shares textures across runners on the same page.
const bakedHolds = new Map<string, number>();

function holdBaked(src: string): void {
  bakedHolds.set(src, (bakedHolds.get(src) ?? 0) + 1);
}

function releaseBaked(src: string): void {
  const held = bakedHolds.get(src) ?? 0;
  if (held > 1) {
    bakedHolds.set(src, held - 1);
    return;
  }
  bakedHolds.delete(src);
  void Assets.unload(src).catch(() => undefined);
}

function usableColor(value: unknown): Ink | null {
  const text = String(value ?? '');
  const known = colorCache.get(text);
  if (known !== undefined) {
    return known;
  }
  let parsed: Ink | null = null;
  try {
    const color = new Color(text);
    parsed = { color: color.toNumber(), alpha: color.alpha };
  } catch {
    parsed = null;
  }
  colorCache.set(text, parsed);
  return parsed;
}

const LOAD_CONCURRENCY = 12;
// Match Entry's difference between text-box reposition and WebGL offsets.
const TEXT_BOX_TOP_OFFSET = 10 - 5.9;

interface EntityView {
  entity: Entity;
  root: Container;
  sprite: Sprite | null;
  background: Graphics | null;
  text: Text | null;
  decoration: Graphics | null;
  filter: ColorMatrixFilter | null;
  pictureId: string | null;
  // Reuse unchanged text fill objects to avoid rebaking text.
  colour: string | null;
  // Keep strokes and fills just below their source entity.
  brush: PenView | null;
  paint: PenView | null;
  stamps: StampSprite[];
}

// Composite each translucent pen group once so overlapping strokes do not darken.
interface PenView {
  root: Container;
  groups: PenGroup[];
}

interface PenGroup {
  // Cache translucent groups so their alpha applies once to all overlaps.
  node: Container;
  graphics: Graphics;
  segments: SegmentBatch | null;
  // Skip redrawing unchanged groups.
  drawn: string;
}

const PAINT_FIRST = ['paint', 'brush'] as const;
const BRUSH_FIRST = ['brush', 'paint'] as const;

// Create each pen layer in the order the entity first uses it.
function penOrderOf(entity: Entity): ReadonlyArray<'paint' | 'brush'> {
  const paint = entity.paint?.started ?? Infinity;
  const brush = entity.brush?.started ?? Infinity;
  return paint <= brush ? PAINT_FIRST : BRUSH_FIRST;
}

function svgSize(head: string): { width: number; height: number } | null {
  const width = /\swidth\s*=\s*["']([\d.]+)/.exec(head);
  const height = /\sheight\s*=\s*["']([\d.]+)/.exec(head);
  if (width && height) {
    return { width: Number(width[1]), height: Number(height[1]) };
  }
  const box = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head);
  return box ? { width: Number(box[1]), height: Number(box[2]) } : null;
}

// Enable mipmaps for oversized vector textures so scaled and rotated drawings stay smooth.
function vectorTextureData(
  width: number,
  height: number,
  resolution: number,
): Record<string, unknown> {
  // Match the explicit SVG dimensions so PIXI allocates a canvas of the intended size.
  return { width, height, resolution, autoGenerateMipmaps: true };
}

// Set SVG pixel dimensions before loading so the browser rasterizes sharply instead of enlarging pixels.
function overlayTextResolution(displayScale: number): number {
  return Math.min(MAX_SHARPNESS, Math.max(MIN_TEXT_SHARPNESS, Math.ceil(displayScale * 2) / 2));
}

export function isVectorUrl(url: string): boolean {
  return /\.svg(?:[?#]|$)/i.test(url) || /^data:image\/svg\+xml[;,]/i.test(url);
}

export function sizedVector(text: string, width: number, height: number): string {
  const open = /<svg\b[^>]*>/i.exec(text);
  if (!open) return '';
  const head = open[0]
    .replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\/?>$/, '');
  const sized = `${head} width="${Math.round(width)}" height="${Math.round(height)}">`;
  const body = text.slice(open.index + open[0].length);
  const whole = `${text.slice(0, open.index)}${sized}${body}`;
  // Use an SVG data URL because PIXI cannot choose the SVG loader from a blob URL.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(whole)}`;
}

const sameStyle = (a: Stroke, b: Stroke) =>
  a.color === b.color &&
  a.thickness === b.thickness &&
  a.opacity === b.opacity &&
  a.fill === b.fill;

interface OwnedContainer extends Container {
  __entity?: Entity;
}

export interface RendererOptions {
  canvas?: HTMLCanvasElement;
  parent?: HTMLElement;
  /** Extra sharpness on top of the device pixel ratio. */
  quality?: number;
  background?: string;
  antialias?: boolean;
  /** Take the vector costume where one exists. On unless turned off. */
  svg?: boolean;
  /**
   * 부스트 모드 — 엔트리에서 이것은 **WebGL 렌더러를 고르는 스위치**입니다
   * (`Entry.setBasicPaint` 의 `GEHelper.isWebGL`). 켜면 채우기가 PIXI 로 가고,
   * 끄면 캔버스로 가는데 둘은 자기교차 경로를 다르게 칠합니다. VM 과 같이 기본은 켬입니다.
   */
  boost?: boolean;
}

// Oversized Entry vectors may lose saved framing; use their raster copy instead.
export const PAINT_CANVAS = { width: 960, height: 540 };

// Rasterize again only after sharpness grows by this amount.
const SVG_REBAKE_RATIO = 1.25;
const BUDGET_PASSES = 8;
const SVG_PEEK = 4096;
// Allow one pixel of size mismatch for rounding during Entry saves.
const SIZE_SLACK = 1;

export class PixiRenderer implements Renderer {
  readonly app = new Application();
  readonly world = new Container();
  private readonly sceneLayers = new Map<string, Container>();
  private readonly sceneTargets = new Map<string, Target[]>();
  private readonly views = new Map<Entity, EntityView>();
  private inspection: { entity: Entity | null; bounds: Graphics; highlight: Graphics; all: boolean; at: number } | null = null;
  private readonly inspectionRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly penDirty = new Set<Entity>();
  private readonly textures = new Map<string, Texture>();
  private readonly images = new Map<string, CanvasImageSource>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly svgBaked = new Map<string, Baked>();
  // Cache SVG markup so resized copies do not fetch it again.
  private readonly svgTexts = new Map<string, string>();
  private readonly pictures = new Map<string, Picture>();
  private overlay: Overlay | null = null;
  private quality: number;
  private ready = false;
  private lastResolution = 0;
  private svgBudget = 1;
  private svgSizes: Array<{ id: string; width: number; height: number }> = [];
  private readonly syncFailed = new WeakSet<Entity>();
  private fontsWait: Promise<void> | null = null;
  private readonly svgPicks = new Map<string, boolean>();
  // Track the largest drawn scale without shrinking it again.
  private readonly svgScales = new Map<string, number>();
  // Recheck growing vectors once at the end of flush.
  private svgScaleGrew = false;
  private readonly measureStyle = new TextStyle();
  // Cache finished strokes because they never change; measure only the active stroke again.
  private fillCache = new WeakMap<Stroke, { boost: boolean; parts: number[][] | null }>();

  private measureCanvas: CanvasRenderingContext2D | null | undefined;

  constructor(options: RendererOptions = {}) {
    this.quality = options.quality ?? 1;
    this.options = options;
  }

  private options: RendererOptions;

  async init(): Promise<void> {
    const options = this.options;
    await this.app.init({
      width: stage.worldWidth,
      height: stage.worldHeight,
      background: options.background ?? '#ffffff',
      antialias: options.antialias ?? true,
      autoDensity: false,
      resolution: this.pixelRatio(),
      canvas: options.canvas,
      preference: 'webgl',
    });
    this.app.ticker.autoStart = false;
    this.app.ticker.stop();
    this.applyStageSize();
    this.app.stage.addChild(this.world);
    this.overlay = new Overlay(this.app.stage);
    // Clear to the stage color before loading so an opaque WebGL canvas does not show black.
    this.app.canvas.style.background = options.background ?? '#ffffff';
    this.app.renderer.render(this.app.stage);
    if (options.parent && !options.canvas) {
      options.parent.appendChild(this.app.canvas);
    }
    this.ready = true;
  }

  private pixelRatio(): number {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    return Math.max(1, Math.min(MAX_SHARPNESS, dpr * this.quality));
  }

  // Texture sharpness includes Entry's 4/3 stage scale and renderer resolution.
  private displayScale(): number {
    const resolution = this.ready ? this.app.renderer.resolution : this.pixelRatio();
    return stage.scale * resolution;
  }

  private svgResolution(picture: Picture): number {
    return svgSharpness(
      this.displayScale(),
      picture.dimension.width,
      picture.dimension.height,
      this.svgBudget,
      this.svgScales.get(picture.id) ?? 1,
    );
  }

  // Round drawn scale upward in half steps to avoid rasterizing again every frame.
  private noteSvgScale(entity: Entity): void {
    const id = entity.picture?.id;
    if (!id || !this.svgBaked.has(id)) {
      return;
    }
    const drawn = Math.ceil(Math.max(Math.abs(entity.scaleX), Math.abs(entity.scaleY)) * 2) / 2;
    if (drawn <= (this.svgScales.get(id) ?? 1)) {
      return;
    }
    this.svgScales.set(id, drawn);
    this.svgScaleGrew = true;
  }

  // Share the vector texture budget so hundreds of costumes cannot exhaust GPU memory.
  private setSvgBudget(targets: Target[]): void {
    const counted = new Set<string>();
    this.svgSizes = [];
    for (const target of targets) {
      for (const picture of target.pictures) {
        if (picture.imageType === 'svg' && !counted.has(picture.id)) {
          counted.add(picture.id);
          this.svgSizes.push({ id: picture.id, ...picture.dimension });
        }
      }
    }
    this.fitSvgBudget();
  }

  // Recompute after scaling because pixel caps and half-step rounding change the final budget.
  private fitSvgBudget(): void {
    const display = this.displayScale();
    let budget = 1;
    for (let pass = 0; pass < BUDGET_PASSES; pass += 1) {
      let pixels = 0;
      for (const { id, width, height } of this.svgSizes) {
        const one = svgSharpness(display, width, height, budget, this.svgScales.get(id) ?? 1);
        pixels += width * height * one * one;
      }
      const tighter = svgBudgetScale(pixels);
      if (tighter === 1) {
        break;
      }
      budget *= tighter;
    }
    this.svgBudget = budget;
  }

  applyStageSize(): void {
    this.world.position.set(stage.worldWidth / 2, stage.worldHeight / 2);
    this.world.scale.set(stage.scale);
    this.overlay?.applyStageSize();
    if (this.ready) {
      this.lastResolution = 0;
      this.app.renderer.resize(stage.worldWidth, stage.worldHeight);
    }
  }

  layout(width: number, height: number): { width: number; height: number } | null {
    if (!this.ready) {
      return null;
    }
    const fit = Math.min(width / stage.worldWidth, height / stage.worldHeight);
    const cssWidth = Math.max(1, Math.floor(stage.worldWidth * fit));
    const cssHeight = Math.max(1, Math.floor(stage.worldHeight * fit));
    // Keep at least HD buffer width, or full HD when displayed that wide.
    const floorWidth = cssWidth >= MIN_CANVAS_WIDTH ? FULLSCREEN_CANVAS_WIDTH : MIN_CANVAS_WIDTH;
    const resolution = Math.min(
      MAX_SHARPNESS,
      Math.max(floorWidth / stage.worldWidth, (cssWidth / stage.worldWidth) * this.pixelRatio()),
    );
    if (this.lastResolution !== resolution) {
      this.lastResolution = resolution;
      this.app.renderer.resolution = resolution;
      this.app.renderer.resize(stage.worldWidth, stage.worldHeight);
      // Rebuild text and vector textures when a larger canvas changes sharpness and budget.
      this.markTextDirty();
      this.fitSvgBudget();
      void this.rebakeVectors();
      this.overlay?.setTextResolution(overlayTextResolution(stage.scale * resolution));
      // Draw immediately after resize so paused or idle stages do not stay black.
      this.app.renderer.render(this.app.stage);
    }
    const canvas = this.app.canvas;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    return { width: cssWidth, height: cssHeight };
  }

  setQuality(quality: number): void {
    this.quality = quality;
  }

  private markTextDirty(): void {
    for (const [entity, view] of this.views) {
      if (view.text) {
        entity.dirty = true;
      }
    }
  }

  // Keep old vector textures valid until their replacements are ready.
  private async rebakeVectors(): Promise<void> {
    const jobs: Array<{ id: string; url: string; resolution: number }> = [];
    for (const [id, baked] of this.svgBaked) {
      const picture = this.pictures.get(id);
      if (!picture) {
        continue;
      }
      const wanted = this.svgResolution(picture);
      if (wanted > baked.resolution * SVG_REBAKE_RATIO) {
        jobs.push({ id, url: baked.url, resolution: wanted });
      }
    }
    // Limit parallel rasterization so loading many vectors cannot stall every frame.
    await pool(jobs, LOAD_CONCURRENCY, (job) => this.bakeVector(job.id, job.url, job.resolution));
  }

  private async bakeVector(id: string, url: string, resolution: number): Promise<void> {
    const previous = this.svgBaked.get(id);
    const picture = this.pictures.get(id);
    if (!picture) {
      return;
    }
    let src = url;
    try {
      const loaded = await this.loadVector(picture, url, resolution);
      src = loaded.src;
      this.keepBaked(id, { url, src, resolution });
      const texture = loaded.texture;
      this.textures.set(id, texture);
      // Keep collision masks at their original scale so resizing cannot change collision results.
      for (const [entity, view] of this.views) {
        if (view.sprite && view.pictureId === id) {
          view.pictureId = null;
          entity.dirty = true;
        }
      }
      // Release unused rasterizations so each resize does not leak another texture.
      this.dropBaked(previous);
    } catch {
      // Keep the currently visible texture if replacing it fails.
      const failed = this.svgBaked.get(id);
      if (failed && failed !== previous) {
        this.svgBaked.delete(id);
        this.dropBaked(failed);
      }
      this.svgBaked.set(id, previous ?? { url, src, resolution });
    }
  }

  private keepBaked(id: string, baked: Baked): void {
    this.svgBaked.set(id, baked);
    if (baked.src !== baked.url) {
      holdBaked(baked.src);
    }
  }

  private dropBaked(baked: Baked | undefined): void {
    if (baked && baked.src !== baked.url) {
      releaseBaked(baked.src);
    }
  }

  canvasRect(): DOMRect {
    return this.app.canvas.getBoundingClientRect();
  }

  setCursor(cursor: string): void {
    const canvas = this.app.canvas;
    if (canvas.style.cursor !== cursor) {
      canvas.style.cursor = cursor;
    }
  }

  setInspection(entity: Entity | null, all = false): void {
    if (this.inspection?.entity === entity && this.inspection.all === all) return;
    if (!entity && !all) {
      this.inspection?.bounds.destroy();
      this.inspection?.highlight.destroy();
      this.inspection = null;
      return;
    }
    if (!this.inspection) {
      const bounds = new Graphics();
      const highlight = new Graphics();
      bounds.eventMode = highlight.eventMode = 'none';
      this.app.stage.addChild(bounds, highlight);
      this.inspection = { entity, bounds, highlight, all, at: -Infinity };
    } else {
      this.inspection.entity = entity;
      this.inspection.all = all;
      this.inspection.at = -Infinity;
    }
  }

  private drawInspection(): void {
    const inspect = this.inspection;
    if (!inspect) return;
    const draw = (entity: Entity, graphics: Graphics, selected: boolean) => {
      if (entity.removed || !this.sceneLayers.get(entity.target.sceneId)?.visible) return;
      const rect = entityBounds(entity, this.inspectionRect);
      if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)
        || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;
      if (rect.x > stage.worldWidth || rect.y > stage.worldHeight
        || rect.x + rect.width < 0 || rect.y + rect.height < 0) return;
      graphics.rect(rect.x, rect.y, Math.max(1, rect.width), Math.max(1, rect.height));
      if (selected) {
        graphics.fill({ color: 0xff4fa3, alpha: 0.2 });
        graphics.stroke({ color: 0xff4fa3, width: 2, alpha: entity.visible ? 0.9 : 0.35 });
      }
    };
    const now = performance.now();
    // Whole-scene boxes update at 10 Hz; one hovered target follows each rendered frame.
    if (now - inspect.at >= 100) {
      inspect.at = now;
      inspect.bounds.clear();
      if (inspect.all) {
        for (const entity of this.views.keys()) draw(entity, inspect.bounds, false);
        inspect.bounds.stroke({ color: 0x3488cf, width: 1, alpha: 0.7 });
      }
    }
    inspect.highlight.clear();
    if (inspect.entity && this.views.has(inspect.entity)) draw(inspect.entity, inspect.highlight, true);
  }

  // Keep a flat display list because clones, strokes, and stamps can sit between other objects.
  attach(targets: Target[], scenes: Array<{ id: string }>): void {
    this.reset();
    for (const scene of scenes) {
      const layer = new Container();
      layer.visible = false;
      layer.sortableChildren = false;
      this.sceneLayers.set(scene.id, layer);
      this.world.addChild(layer);
    }
    for (const scene of scenes) {
      const layer = this.sceneLayers.get(scene.id)!;
      const own = targets.filter((target) => target.sceneId === scene.id);
      this.sceneTargets.set(scene.id, own);
      // The last display object is furthest back.
      for (let i = own.length - 1; i >= 0; i -= 1) {
        const view = this.makeView(own[i]!.entity);
        this.views.set(own[i]!.entity, view);
        layer.addChild(view.root);
      }
    }
  }

  // Reset scene layers on entry so order changes from a previous visit do not persist.
  private sortScene(sceneId: string): void {
    const layer = this.sceneLayers.get(sceneId);
    const targets = this.sceneTargets.get(sceneId);
    if (!layer || !targets) {
      return;
    }
    for (const target of targets) {
      const view = this.views.get(target.entity);
      if (!view) {
        continue;
      }
      for (const stamp of view.stamps) {
        this.dropStamp(stamp);
      }
      view.stamps = [];
      view.brush?.root.destroy({ children: true });
      view.paint?.root.destroy({ children: true });
      view.brush = null;
      view.paint = null;
    }
    for (const child of [...layer.children] as OwnedContainer[]) {
      if (!child.__entity || child.__entity.isClone) {
        layer.removeChild(child);
        child.destroy();
      }
    }
    let index = 0;
    for (let i = targets.length - 1; i >= 0; i -= 1) {
      const view = this.views.get(targets[i]!.entity);
      if (view && layer.getChildIndex(view.root) >= 0) {
        layer.setChildIndex(view.root, index);
        index += 1;
      }
    }
  }

  // Exclude strokes and stamps when reporting an entity's object index.
  drawOrder(sceneId: string): Entity[] {
    const layer = this.sceneLayers.get(sceneId);
    if (!layer) {
      return [];
    }
    const children = layer.children as OwnedContainer[];
    const order: Entity[] = [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const entity = children[i]?.__entity;
      if (entity) {
        order.push(entity);
      }
    }
    return order;
  }

  private layerOf(entity: Entity): Container | null {
    return this.sceneLayers.get(entity.target.sceneId) ?? null;
  }

  private indexUnder(entity: Entity): number {
    const layer = this.layerOf(entity);
    const view = this.views.get(entity);
    if (!layer || !view) {
      return -1;
    }
    const index = layer.getChildIndex(view.root);
    return index < 0 ? -1 : index;
  }

  reset(): void {
    this.setInspection(null);
    for (const view of this.views.values()) {
      // Release stamp texture references separately because other runners may still use them.
      for (const stamp of view.stamps) {
        this.dropStamp(stamp);
      }
      view.stamps = [];
      view.root.destroy({ children: true });
    }
    this.views.clear();
    for (const layer of this.sceneLayers.values()) {
      layer.destroy({ children: true });
    }
    this.sceneLayers.clear();
    this.sceneTargets.clear();
    this.overlay?.clear();
  }

  destroy(): void {
    if (!this.ready) {
      return;
    }
    this.ready = false;
    this.reset();
    this.textures.clear();
    this.images.clear();
    this.loading.clear();
    // Unload shared textures only after the last runner releases them.
    for (const baked of this.svgBaked.values()) {
      this.dropBaked(baked);
    }
    this.svgBaked.clear();
    this.svgScales.clear();
    this.pictures.clear();
    this.app.destroy({ removeView: true }, { children: true });
  }

  // Redraw fills and text when boost changes because Entry uses different rendering rules.
  setBoost(on: boolean): void {
    if (this.options.boost === on) {
      return;
    }
    this.options.boost = on;
    // Clear cached splits because the fill rule changed.
    this.fillCache = new WeakMap();
    for (const [entity, view] of this.views) {
      for (const which of PAINT_FIRST) {
        for (const group of view[which]?.groups ?? []) {
          group.drawn = "";
        }
      }
      if (entity.paint || entity.brush) {
        this.penDirty.add(entity);
      }
      if (entity.type === "textBox") {
        entity.measure(false);
        entity.dirty = true;
      }
    }
    this.flush();
  }

  setScene(sceneId: string): void {
    this.sortScene(sceneId);
    for (const [id, layer] of this.sceneLayers) {
      layer.visible = id === sceneId;
    }
  }

  // Insert clones directly below their source entity, after skipping its strokes and stamps.
  addEntity(entity: Entity, source?: Entity): void {
    if (this.views.has(entity)) {
      return;
    }
    const layer = this.layerOf(entity);
    if (!layer) {
      return;
    }
    const view = this.makeView(entity);
    this.views.set(entity, view);
    if (source) {
      const sourceView = this.views.get(source);
      const base = this.indexUnder(source);
      const offset =
        (sourceView?.brush ? 1 : 0) + (sourceView?.paint ? 1 : 0) + (sourceView?.stamps.length ?? 0);
      const index = base < 0 ? -1 : Math.max(0, base - offset);
      if (index >= 0) {
        layer.addChildAt(view.root, Math.min(index, layer.children.length));
      } else {
        layer.addChild(view.root);
      }
    } else {
      layer.addChild(view.root);
    }
    entity.dirty = true;
  }

  removeEntity(entity: Entity): void {
    const view = this.views.get(entity);
    this.penDirty.delete(entity);
    // Remove the overlay bubble even if its entity view has already gone.
    this.overlay?.forget(entity);
    if (!view) {
      return;
    }
    for (const stamp of view.stamps) {
      this.dropStamp(stamp);
    }
    view.brush?.root.destroy({ children: true });
    view.paint?.root.destroy({ children: true });
    view.root.destroy({ children: true });
    this.views.delete(entity);
  }

  private makeView(entity: Entity): EntityView {
    const root: OwnedContainer = new Container();
    root.__entity = entity;
    if (entity.type === 'textBox') {
      const background = new Graphics();
      const text = new Text({
        text: entity.text,
        style: {
          fontFamily: entity.fontFamily,
          fontSize: entity.fontSize,
          fill: usableColor(entity.colour) ?? { color: 0x000000, alpha: 1 },
          align: 'center',
        },
        resolution: this.textResolution(entity),
      });
      text.anchor.set(0.5, 0.5);
      const decoration = new Graphics();
      root.addChild(background, text, decoration);
      return {
        entity,
        root,
        sprite: null,
        background,
        text,
        decoration,
        filter: null,
        pictureId: null,
        colour: null,
        brush: null,
        paint: null,
        stamps: [],
      };
    }
    const sprite = new Sprite(Texture.EMPTY);
    root.addChild(sprite);
    return {
      entity,
      root,
      sprite,
      background: null,
      text: null,
      decoration: null,
      filter: null,
      pictureId: null,
      colour: null,
      brush: null,
      paint: null,
      stamps: [],
    };
  }

  // Load the first scene first and limit parallel costume requests to keep the page responsive.
  async preload(
    targets: Target[],
    sceneId?: string,
    onLoaded?: () => void,
  ): Promise<void> {
    const inScene: Picture[] = [];
    const rest: Picture[] = [];
    for (const target of targets) {
      const bucket = !sceneId || target.sceneId === sceneId ? inScene : rest;
      bucket.push(...target.pictures);
    }
    this.setSvgBudget(targets);
    const one = async (picture: Picture) => {
      await this.loadPicture(picture);
      onLoaded?.();
    };
    await pool(inScene, LOAD_CONCURRENCY, one);
    await pool(rest, LOAD_CONCURRENCY, one);
  }

  static costumeCount(targets: Target[]): number {
    return targets.reduce((total, target) => total + target.pictures.length, 0);
  }

  private async pickUrl(picture: Picture): Promise<string> {
    if (picture.imageType !== 'svg' || !picture.fileurl.endsWith('.svg')) {
      return picture.fileurl;
    }
    if (!picture.pngurl) {
      await this.fontsReady();
      return picture.fileurl;
    }
    if (this.options.svg === false) {
      return picture.pngurl;
    }
    await this.fontsReady();
    return (await this.vectorIsBetter(picture)) ? picture.fileurl : picture.pngurl;
  }

  // Prefer the raster when SVG framing differs or embedded images and text would render differently.
  private async vectorIsBetter(picture: Picture): Promise<boolean> {
    const url = picture.fileurl;
    const known = this.svgPicks.get(url);
    if (known !== undefined) {
      return known;
    }
    let better = false;
    try {
      const svg = await this.svgText(url);
      // Scan the whole SVG because image and text tags can appear far beyond the header.
      const size = svgSize(svg.slice(0, SVG_PEEK));
      better =
        size !== null &&
        Math.abs(size.width - picture.dimension.width) <= SIZE_SLACK &&
        Math.abs(size.height - picture.dimension.height) <= SIZE_SLACK &&
        size.width <= PAINT_CANVAS.width &&
        size.height <= PAINT_CANVAS.height &&
        !/<image[\s>]/i.test(svg) &&
        !/<text[\s>]/i.test(svg);
    } catch {
      // Keep the raster copy when the SVG cannot be read.
    }
    this.svgPicks.set(url, better);
    return better;
  }

  private async svgText(url: string): Promise<string> {
    const known = this.svgTexts.get(url);
    if (known !== undefined) {
      return known;
    }
    const text = await (await fetch(url)).text();
    this.svgTexts.set(url, text);
    return text;
  }

  // Retry the original URL if loading the resized SVG copy fails.
  private async loadVector(
    picture: Picture,
    url: string,
    resolution: number,
  ): Promise<{ texture: Texture; src: string }> {
    const sized = await this.vectorSource(url, picture, resolution);
    const data = vectorTextureData(picture.dimension.width, picture.dimension.height, resolution);
    if (sized !== url) {
      try {
        return { texture: (await Assets.load({ src: sized, data })) as Texture, src: sized };
      } catch {
      }
    }
    return { texture: (await Assets.load({ src: url, data })) as Texture, src: url };
  }

  private async vectorSource(
    url: string,
    picture: Picture,
    resolution: number,
  ): Promise<string> {
    try {
      const sized = sizedVector(
        await this.svgText(url),
        picture.dimension.width * resolution,
        picture.dimension.height * resolution,
      );
      return sized || url;
    } catch {
      return url;
    }
  }

  // Wait for fonts before rasterizing SVG text; raster images and sounds do not need them.
  private fontsReady(): Promise<void> {
    if (!this.fontsWait) {
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      this.fontsWait = fonts ? fonts.ready.then(() => undefined).catch(() => undefined) : Promise.resolve();
    }
    return this.fontsWait;
  }

  async loadPicture(picture: Picture): Promise<void> {
    if (this.textures.has(picture.id)) {
      return;
    }
    const inFlight = this.loading.get(picture.id);
    if (inFlight) {
      await inFlight;
      return;
    }
    this.pictures.set(picture.id, picture);
    const job = (async () => {
      try {
        const url = await this.pickUrl(picture);
        const resolution = this.svgResolution(picture);
        const vector = isVectorUrl(url);
        // Mipmaps keep raster costumes smooth when drawn much smaller than their source.
        const loaded = vector
          ? await this.loadVector(picture, url, resolution)
          : { texture: (await Assets.load({ src: url, data: { autoGenerateMipmaps: true } })) as Texture, src: url };
        const texture = loaded.texture;
        if (vector) {
          this.keepBaked(picture.id, { url, src: loaded.src, resolution });
        }
        this.textures.set(picture.id, texture);
        const resource = texture.source?.resource as CanvasImageSource | undefined;
        if (resource) {
          this.images.set(picture.id, resource);
        }
      } catch {
        this.textures.set(picture.id, Texture.EMPTY);
      } finally {
        this.loading.delete(picture.id);
      }
    })();
    this.loading.set(picture.id, job);
    await job;
  }

  maskFor(pictureId: string, width: number, height: number): AlphaMask | null {
    const source = this.images.get(pictureId);
    return source ? buildMask(source, width, height) : null;
  }

  flush(): void {
    if (!this.ready) {
      return;
    }
    for (const [entity, view] of this.views) {
      if (entity.dirty) {
        // Keep an object's last good frame if drawing it fails, and let the rest of the work continue.
        try {
          this.sync(entity, view);
        } catch (error) {
          this.reportSyncFailure(entity, error);
        }
        entity.dirty = false;
      }
    }
    if (this.penDirty.size) {
      for (const entity of this.penDirty) {
        this.redrawPen(entity);
      }
      this.penDirty.clear();
    }
    if (this.svgScaleGrew) {
      this.svgScaleGrew = false;
      this.fitSvgBudget();
      void this.rebakeVectors();
    }
    this.overlay?.flush();
    this.drawInspection();
    this.app.renderer.render(this.app.stage);
  }

  // Report drawing failures once per object to avoid flooding the console.
  private reportSyncFailure(entity: Entity, error: unknown): void {
    if (this.syncFailed.has(entity)) {
      return;
    }
    this.syncFailed.add(entity);
    console.warn(`[tessvm] '${entity.target.name}' 을(를) 그리지 못했습니다`, error);
  }

  private sync(entity: Entity, view: EntityView): void {
    const root = view.root;
    root.visible = entity.visible;
    root.position.set(entity.x, -entity.y);
    root.rotation = (entity.rotation * Math.PI) / 180;
    root.scale.set(entity.scaleX, entity.scaleY);
    root.alpha = entity.effect.alpha;

    if (view.sprite) {
      const picture = entity.picture;
      if (picture && view.pictureId !== picture.id) {
        const texture = this.textures.get(picture.id);
        if (texture) {
          view.sprite.texture = texture;
          view.pictureId = picture.id;
        } else {
          void this.loadPicture(picture).then(() => {
            entity.dirty = true;
          });
        }
      }
      this.noteSvgScale(entity);
      view.sprite.width = entity.width;
      view.sprite.height = entity.height;
      root.pivot.set(entity.regX, entity.regY);
      this.applyEffects(entity, view);
    } else {
      this.syncTextBox(entity, view);
    }
  }

  private applyEffects(entity: Entity, view: EntityView): void {
    const effect = entity.effect;
    const needsFilter = effect.brightness !== 0 || effect.hsv !== 0 || effect.hue !== 0;
    if (!needsFilter) {
      if (view.filter) {
        view.root.filters = [];
        view.filter = null;
      }
      return;
    }
    let filter = view.filter;
    if (!filter) {
      // Inherit canvas resolution in filters so effects do not reduce an object's sharpness.
      filter = new ColorMatrixFilter({ resolution: 'inherit', antialias: 'inherit' });
      view.filter = filter;
      view.root.filters = [filter];
    }
    filter.matrix = colorMatrix(effect.brightness, effect.hsv, effect.hue) as never;
  }

  // Update entity text bounds because collision and speech-bubble placement read them immediately.
  private syncTextBox(entity: Entity, view: EntityView): void {
    const text = view.text!;
    const background = view.background!;
    const decoration = view.decoration!;
    const style = text.style;
    const align: 'center' | 'left' | 'right' =
      entity.textAlign === 1 ? 'left' : entity.textAlign === 2 ? 'right' : 'center';
    // Use Entry's single font family because adding fallbacks changes measured line height.
    style.fontFamily = entity.fontFamily;
    style.fontSize = entity.fontSize;
    // Ignore invalid colors and replace fill objects only on changes to avoid rebaking long text each frame.
    if (view.colour !== entity.colour) {
      const fill = usableColor(entity.colour);
      if (fill !== null) {
        style.fill = { color: fill.color, alpha: fill.alpha };
      }
      view.colour = entity.colour;
    }
    style.fontWeight = entity.fontBold ? 'bold' : 'normal';
    style.fontStyle = entity.fontItalic ? 'italic' : 'normal';
    style.align = align;
    style.lineHeight = entity.fontSize + 2;
    if (entity.lineBreak) {
      style.wordWrap = true;
      style.wordWrapWidth = entity.width;
      style.breakWords = true;
    } else {
      style.wordWrap = false;
    }
    if (text.text !== entity.text) {
      text.text = entity.text;
    }
    const resolution = this.textResolution(entity, text);
    if (text.resolution !== resolution) {
      text.resolution = resolution;
    }

    // Move the anchor for text alignment rather than moving the text itself.
    const anchorX = align === 'left' ? 0 : align === 'right' ? 1 : 0.5;
    if (entity.lineBreak) {
      // Pin wrapped text to the top of its saved box.
      text.anchor.set(anchorX, 0);
      text.position.set(
        align === 'left' ? -entity.width / 2 : align === 'right' ? entity.width / 2 : 0,
        -entity.height / 2 + TEXT_BOX_TOP_OFFSET,
      );
    } else if (this.options.boost === false) {
      // Canvas Entry centers the first line, then draws later lines below it.
      text.anchor.set(anchorX, 0);
      text.position.set(0, -(entity.fontSize + 2) / 2);
    } else {
      // Boost Entry centers the whole text block instead.
      text.anchor.set(anchorX, 0.5);
      text.position.set(0, 0);
    }

    background.clear();
    const bg = entity.bgColor?.startsWith('#') ? usableColor(entity.bgColor) : null;
    if (bg !== null) {
      const offset = entity.lineBreak
        ? 0
        : align === 'left'
          ? entity.width / 2
          : align === 'right'
            ? -entity.width / 2
            : 0;
      background
        .rect(offset - entity.width / 2, -entity.height / 2, entity.width, entity.height)
        .fill({ color: bg.color, alpha: bg.alpha });
    }

    decoration.clear();
    const ink = usableColor(entity.colour);
    if ((entity.underLine || entity.strike) && ink !== null) {
      const width = text.width;
      const left = text.x - width * text.anchor.x;
      const top = text.y - text.height * text.anchor.y;
      const thickness = Math.max(1, entity.fontSize / 14);
      if (entity.underLine) {
        decoration
          .rect(left, top + text.height - thickness, width, thickness)
          .fill({ color: ink.color, alpha: ink.alpha });
      }
      if (entity.strike) {
        decoration
          .rect(left, top + text.height / 2 - thickness / 2, width, thickness)
          .fill({ color: ink.color, alpha: ink.alpha });
      }
    }
  }

  // Include object scale and use half steps so text stays sharp without rebaking every frame.
  private textResolution(entity: Entity, drawn?: Text): number {
    const scale = Math.max(Math.abs(entity.scaleX), Math.abs(entity.scaleY));
    const longest = Math.max(drawn?.width ?? entity.width, drawn?.height ?? entity.height);
    return textSharpness(this.displayScale(), scale, longest);
  }

  private styleFor(entity: Entity, style: TextStyle): TextStyle {
    style.fontFamily = entity.fontFamily;
    style.fontSize = entity.fontSize;
    // Validate colors even during measurement because PIXI still parses the style.
    style.fill = usableColor(entity.colour)?.color ?? 0x000000;
    style.fontWeight = entity.fontBold ? 'bold' : 'normal';
    style.fontStyle = entity.fontItalic ? 'italic' : 'normal';
    style.align = entity.textAlign === 1 ? 'left' : entity.textAlign === 2 ? 'right' : 'center';
    style.lineHeight = entity.fontSize + 2;
    if (entity.lineBreak) {
      style.wordWrap = true;
      style.wordWrapWidth = entity.width;
      style.breakWords = true;
    } else {
      style.wordWrap = false;
    }
    return style;
  }

  // Measure text immediately so a following size block sees the change in the same frame.
  measureTextBox(entity: Entity): { width: number; height: number } | null {
    if (entity.type !== 'textBox') {
      return null;
    }
    const metrics = CanvasTextMetrics.measureText(
      entity.text,
      this.styleFor(entity, this.measureStyle),
    );
    // Canvas Entry measures all text together; boost measures the longest individual line.
    const whole =
      this.options.boost === false && !entity.lineBreak ? this.measureWhole(entity) : null;
    return { width: whole ?? metrics.width, height: metrics.height };
  }

  // Fall back to PIXI measurement when no canvas context is available.
  private measureWhole(entity: Entity): number | null {
    const context = (this.measureCanvas ??= document
      .createElement('canvas')
      .getContext('2d'));
    if (!context) {
      return null;
    }
    context.font = [
      entity.fontBold && 'bold',
      entity.fontItalic && 'italic',
      `${entity.fontSize}px`,
      entity.fontFamily,
    ]
      .filter(Boolean)
      .join(' ');
    return context.measureText(entity.text).width;
  }

  // Clear PIXI's cached font metrics and remeasure after web fonts finish loading.
  async waitForFonts(): Promise<void> {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) {
      return;
    }
    try {
      await fonts.ready;
    } catch {
      return;
    }
    CanvasTextMetrics.clearMetrics();
    for (const [entity, view] of this.views) {
      if (entity.type === 'textBox' && view.text) {
        // Nudge the family name to force PIXI to discard its previous measurement.
        view.text.style.fontFamily = 'sans-serif';
        // Refresh only width because loading the font does not change the saved height.
        entity.measure(false);
        entity.dirty = true;
      }
    }
    this.flush();
  }

  private penLayer(view: EntityView, which: 'brush' | 'paint'): PenView | null {
    const existing = view[which];
    if (existing) {
      return existing;
    }
    const layer = this.layerOf(view.entity);
    if (!layer) {
      return null;
    }
    const root = new Container();
    const index = this.indexUnder(view.entity);
    layer.addChildAt(root, index < 0 ? layer.children.length : index);
    const pen: PenView = { root, groups: [] };
    view[which] = pen;
    return pen;
  }

  private penGroup(pen: PenView, index: number): PenGroup {
    const existing = pen.groups[index];
    if (existing) {
      return existing;
    }
    const graphics = new Graphics();
    const node = new Container();
    node.addChild(graphics);
    pen.root.addChild(node);
    const group: PenGroup = { node, graphics, segments: null, drawn: '' };
    pen.groups[index] = group;
    return group;
  }

  private clearGroup(group: PenGroup): void {
    group.graphics.clear();
    group.segments?.hide();
    group.drawn = '';
    if (group.node.isCachedAsTexture) {
      group.node.cacheAsTexture(false);
    }
    group.node.alpha = 1;
  }

  // Redraw pen layers once per frame to avoid quadratic work while adding points.
  penChanged(entity: Entity): void {
    this.penDirty.add(entity);
  }

  private redrawPen(entity: Entity): void {
    const view = this.views.get(entity);
    if (!view) {
      return;
    }
    // Keep pen creation order because the later layer must sit in front.
    for (const which of penOrderOf(entity)) {
      const state = entity[which];
      if (!state) {
        continue;
      }
      const pen = this.penLayer(view, which);
      if (!pen) {
        continue;
      }
      const pieces =
        state.path.length >= 4
          ? [
              ...state.strokes,
              {
                color: state.color,
                thickness: state.thickness,
                opacity: state.opacity,
                points: state.path,
                fill: which === 'paint',
              },
            ]
          : state.strokes;

      // Composite translucent groups separately; opaque groups can share a node without changing blending.
      let count = 0;
      let runFrom = -1;
      const closeRun = (to: number): void => {
        if (runFrom >= 0) {
          this.drawPenRun(this.penGroup(pen, count), pieces, runFrom, to);
          count += 1;
          runFrom = -1;
        }
      };
      for (let i = 0; i < pieces.length; ) {
        const style = pieces[i]!;
        let end = i;
        while (end < pieces.length && sameStyle(style, pieces[end]!)) {
          end += 1;
        }
        const from = i;
        i = end;
        // A single-point stroke draws nothing.
        let drawable = 0;
        let straight = 0;
        for (let at = from; at < end; at += 1) {
          if (pieces[at]!.points.length >= 4) {
            drawable += 1;
            if (isSegment(pieces[at]!)) {
              straight += 1;
            }
          }
        }
        if (drawable === 0) {
          continue;
        }
        // Give plain lines and translucent groups their own nodes; batch the remaining opaque paths.
        const alone = style.opacity !== 0 ||
          (!style.fill && straight === drawable && straight >= SEGMENT_FLOOR);
        if (alone) {
          closeRun(from);
          this.drawPenGroup(this.penGroup(pen, count), style, pieces, from, end, drawable);
          count += 1;
        } else if (runFrom < 0) {
          runFrom = from;
        }
      }
      closeRun(pieces.length);
      // Empty unused groups for reuse so clear-and-redraw works do not rebuild GPU buffers every frame.
      for (let at = count; at < pen.groups.length; at += 1) {
        this.clearGroup(pen.groups[at]!);
      }
    }
  }

  // Batch opaque groups in draw order because no alpha blending separates them.
  private drawPenRun(group: PenGroup, pieces: Stroke[], from: number, to: number): void {
    const drawn = `run/${from}/${to}/${pieces[to - 1]!.points.length}/${pieces[from]!.color}`;
    if (group.drawn === drawn) {
      return;
    }
    group.drawn = drawn;
    group.segments?.hide();
    const graphics = group.graphics;
    graphics.clear();
    const boost = this.options.boost !== false;
    for (let at = from; at < to; ) {
      const style = pieces[at]!;
      let end = at;
      while (end < to && sameStyle(style, pieces[end]!)) {
        end += 1;
      }
      this.tracePenGroup(graphics, style, pieces, at, end, boost);
      at = end;
    }
    this.finishPenGroup(group, 1);
  }

  private tracePenGroup(
    graphics: Graphics,
    style: Stroke,
    pieces: Stroke[],
    from: number,
    to: number,
    boost: boolean,
  ): void {
    const trace = (points: number[]): void => {
      graphics.moveTo(points[0]!, points[1]!);
      for (let at = 2; at < points.length; at += 2) {
        graphics.lineTo(points[at]!, points[at + 1]!);
      }
    };
    const traceFlipped = (points: number[]): void => {
      graphics.moveTo(points[0]!, -points[1]!);
      for (let at = 2; at < points.length; at += 2) {
        graphics.lineTo(points[at]!, -points[at + 1]!);
      }
    };
    let drew = false;
    for (let at = from; at < to; at += 1) {
      const piece = pieces[at]!;
      if (piece.points.length < 4) {
        continue;
      }
      drew = true;
      if (!style.fill) {
        traceFlipped(piece.points);
        continue;
      }
      const known = this.fillCache.get(piece);
      let parts: number[][] | null;
      if (known && known.boost === boost) {
        parts = known.parts;
      } else {
        const points = piece.points.map((value, at2) => (at2 % 2 === 1 ? -value : value));
        parts = fillParts(points, boost);
        this.fillCache.set(piece, { boost, parts });
      }
      if (parts) {
        for (const part of parts) trace(part);
      } else {
        traceFlipped(piece.points);
      }
    }
    if (!drew) {
      return;
    }
    const ink = usableColor(style.color) ?? { color: 0x000000, alpha: 1 };
    if (style.fill) {
      graphics.fill({ color: ink.color, alpha: ink.alpha });
    } else {
      graphics.stroke({
        width: style.thickness,
        color: ink.color,
        alpha: ink.alpha,
        cap: 'butt',
        join: 'miter',
      });
    }
  }

  private drawPenGroup(
    group: PenGroup,
    style: Stroke,
    pieces: Stroke[],
    from: number,
    to: number,
    drawable: number,
  ): void {
    const alpha = 1 - style.opacity / 100;
    // Keep unchanged cached groups to avoid allocating fresh textures.
    const drawn = `${style.color}/${style.thickness}/${style.opacity}/${style.fill}/${
      to - from
    }/${pieces[to - 1]!.points.length}`;
    if (group.drawn === drawn) {
      return;
    }
    group.drawn = drawn;

    // Use rectangles only for plain segments; joined corners and fills still need paths.
    let straight = 0;
    if (!style.fill) {
      for (let at = from; at < to; at += 1) {
        if (isSegment(pieces[at]!)) {
          straight += 1;
        }
      }
    }
    const ink = usableColor(style.color) ?? { color: 0x000000, alpha: 1 };
    const batched = straight === drawable && straight >= SEGMENT_FLOOR;
    if (batched) {
      if (!group.segments) {
        group.segments = new SegmentBatch(group.node);
      }
      group.segments.set(pieces, from, to, style.thickness, ink.color, ink.alpha);
    } else {
      group.segments?.hide();
    }

    const graphics = group.graphics;
    graphics.clear();
    if (batched) {
      this.finishPenGroup(group, alpha);
      return;
    }
    this.tracePenGroup(graphics, style, pieces, from, to, this.options.boost !== false);
    this.finishPenGroup(group, alpha);
  }

  // Cache each translucent group as one shape so overlaps do not darken; recache growing bounds.
  private finishPenGroup(group: PenGroup, alpha: number): void {
    group.node.alpha = alpha;
    if (group.node.isCachedAsTexture) {
      group.node.cacheAsTexture(false);
    }
    if (alpha < 1) {
      group.node.cacheAsTexture(true);
    }
  }

  stamp(entity: Entity): void {
    const view = this.views.get(entity);
    const layer = this.layerOf(entity);
    const mark = entity.stamps[entity.stamps.length - 1];
    if (!view || !layer || !mark || !mark.picture) {
      return;
    }
    const texture = this.textures.get(mark.picture.id);
    if (!texture) {
      return;
    }
    const sprite = new Sprite(texture) as StampSprite;
    // Retain stamp textures even after a costume is rasterized again at a larger scale.
    const baked = this.svgBaked.get(mark.picture.id);
    if (baked && baked.src !== baked.url) {
      holdBaked(baked.src);
      sprite.__baked = baked.src;
    }
    // Combine texture scale with entity scale so vector stamps keep their displayed size.
    const perPixelX = mark.picture.dimension.width / (texture.width || 1);
    const perPixelY = mark.picture.dimension.height / (texture.height || 1);
    sprite.scale.set(perPixelX * mark.scaleX, perPixelY * mark.scaleY);
    // Sprite pivots use texture pixels rather than costume units.
    sprite.pivot.set(mark.regX / (perPixelX || 1), mark.regY / (perPixelY || 1));
    sprite.position.set(mark.x, -mark.y);
    sprite.rotation = (mark.rotation * Math.PI) / 180;
    sprite.alpha = mark.alpha;
    const index = this.indexUnder(entity);
    layer.addChildAt(sprite, index < 0 ? layer.children.length : index);
    view.stamps.push(sprite);
  }

  private dropStamp(sprite: StampSprite): void {
    if (sprite.__baked) {
      releaseBaked(sprite.__baked);
      sprite.__baked = undefined;
    }
    sprite.destroy();
  }

  eraseAll(entity: Entity): void {
    const view = this.views.get(entity);
    this.penDirty.delete(entity);
    if (!view) {
      return;
    }
    // Reuse cleared pen nodes and GPU buffers for works that redraw every frame.
    for (const pen of [view.brush, view.paint]) {
      for (const group of pen?.groups ?? []) {
        this.clearGroup(group);
      }
    }
    for (const stamp of view.stamps) {
      this.dropStamp(stamp);
    }
    view.stamps = [];
  }

  // Move past neighboring strokes and stamps so one layer step means one object.
  moveEntity(entity: Entity, location: string): void {
    const layer = this.layerOf(entity);
    const view = this.views.get(entity);
    if (!layer || !view) {
      return;
    }
    const children = layer.children as OwnedContainer[];
    const current = layer.getChildIndex(view.root);
    if (current < 0) {
      return;
    }
    const max = children.length - 1;
    const own = 1 + (view.brush ? 1 : 0) + (view.paint ? 1 : 0);
    let target = current;
    switch (location) {
      case 'FRONT':
        target = max;
        break;
      case 'BACK':
        target = 0;
        break;
      case 'FORWARD': {
        if (current === max) {
          return;
        }
        const front = this.views.get(children[current + 1]?.__entity as Entity);
        target += own + (front?.stamps.length ?? 0);
        break;
      }
      default: {
        const backIndex = current - own + view.stamps.length;
        const back = this.views.get(children[backIndex]?.__entity as Entity);
        target = back ? current - own - back.stamps.length : 0;
        break;
      }
    }
    target = Math.max(0, Math.min(max, target));
    if (target !== current) {
      layer.setChildIndex(view.root, target);
    }
  }

  syncDialog(entity: Entity): void {
    this.overlay?.setDialog(entity);
  }

  showTable(table: TableLike | null, chart: number | null = null): void {
    this.overlay?.showTable(table, chart);
  }

  // Ask inputs use HTML, so the page owns their display hooks.
  showQuestion(_text: string): void {}

  hideQuestion(): void {}

  get overlayView(): Overlay | null {
    return this.overlay;
  }
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  });
  await Promise.all(runners);
}

// Match Entry's brightness offset and color-channel rotation.
export function colorMatrix(brightness: number, hsv: number, hue: number): number[] {
  let matrix = identityMatrix();
  if (brightness !== 0) {
    const offset = Math.max(-100, Math.min(100, brightness)) / 255;
    matrix = multiply(matrix, [
      1, 0, 0, 0, offset,
      0, 1, 0, 0, offset,
      0, 0, 1, 0, offset,
      0, 0, 0, 1, 0,
    ]);
  }
  if (hsv !== 0) {
    matrix = multiply(matrix, hsvMatrix(hsv));
  }
  if (hue !== 0) {
    matrix = multiply(matrix, hueMatrix(((hue % 360) + 360) % 360));
  }
  return matrix;
}

function identityMatrix(): number[] {
  return [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
}

function hsvMatrix(hsv: number): number[] {
  const radians = ((hsv * 3.6 * 3) / 180) * Math.PI;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  let v = Math.abs(hsv / 100);
  if (v > 1) {
    v -= Math.floor(v);
  }
  if (v > 0 && v <= 0.33) {
    return [1, 0, 0, 0, 0, 0, cos, sin, 0, 0, 0, -sin, cos, 0, 0, 0, 0, 0, 1, 0];
  }
  if (v <= 0.66) {
    return [cos, 0, sin, 0, 0, 0, 1, 0, 0, 0, sin, 0, cos, 0, 0, 0, 0, 0, 1, 0];
  }
  if (v <= 0.99) {
    return [cos, sin, 0, 0, 0, -sin, cos, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  }
  return identityMatrix();
}

function hueMatrix(degrees: number): number[] {
  const rotation = (degrees / 180) * Math.PI;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const w = 1 / 3;
  const sqrtW = Math.sqrt(w);
  const a00 = cos + (1 - cos) * w;
  const a01 = w * (1 - cos) - sqrtW * sin;
  const a02 = w * (1 - cos) + sqrtW * sin;
  const a10 = w * (1 - cos) + sqrtW * sin;
  const a11 = cos + w * (1 - cos);
  const a12 = w * (1 - cos) - sqrtW * sin;
  const a20 = w * (1 - cos) - sqrtW * sin;
  const a21 = w * (1 - cos) + sqrtW * sin;
  const a22 = cos + w * (1 - cos);
  return [a00, a01, a02, 0, 0, a10, a11, a12, 0, 0, a20, a21, a22, 0, 0, 0, 0, 0, 1, 0];
}

function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(20);
  for (let row = 0; row < 4; row += 1) {
    const base = row * 5;
    for (let column = 0; column < 4; column += 1) {
      out[base + column] =
        a[base]! * b[column]! +
        a[base + 1]! * b[column + 5]! +
        a[base + 2]! * b[column + 10]! +
        a[base + 3]! * b[column + 15]!;
    }
    out[base + 4] =
      a[base]! * b[4]! +
      a[base + 1]! * b[9]! +
      a[base + 2]! * b[14]! +
      a[base + 3]! * b[19]! +
      a[base + 4]!;
  }
  return out;
}

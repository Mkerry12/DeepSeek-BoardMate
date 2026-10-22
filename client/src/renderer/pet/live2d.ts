// Live2D 角色（Cubism 3/4/5）：setBase / setTalking / react / setLayer / flash / motion / setOutfit / propAt / zoneAt
//   / hitTest / setNotes / setLipSync / topY
// 引擎在导入时就要求 window.Live2DCubismCore 存在，所以本模块必须在 Core 加载后再动态导入（见 ./load.ts）
import { Application, extensions } from 'pixi.js';
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism';
import type { Outfit } from '../../shared/types';
import type { Live2DProfile } from '../character/config';

const BOTTOM_MARGIN = 6;
const FADE_SPEED = 8;
const EMOTION_HOLD = 6;
const FLASH_HOLD = 2.5;
const MEASURE_DELAY = 1200;
// 同一槽位里后面的层覆盖前面的层（例如挥手的「双手比耶」暂时替换换装的「喵喵手」）
const LAYER_ORDER = ['activity', 'task', 'emotion', 'flash', 'hover'] as const;

export type LayerKey = (typeof LAYER_ORDER)[number];

/** pet.json 里 expressionSlots 的一项 */
export interface SlotOption {
  label: string;
  expressions?: string[];
  motion?: string;
  clears?: unknown;
  sweep?: Sweep;
}

export interface ExpressionSlot {
  id: string;
  label: string;
  none: string;
  options: SlotOption[];
}

interface Sweep {
  x: string;
  y: string;
  z: string;
  rz: string;
  ampX: number;
  ampY: number;
  ampZ: number;
  driftY: number;
  loopMs: number;
  driftMs: number;
}

/** pet.json sounds：[[频率 Hz, 起始秒], …] */
export type Sounds = Record<string, [number, number][]>;

interface ExpressionParam {
  Id: string;
  Value: number;
  Blend?: 'Add' | 'Multiply' | 'Overwrite';
}

interface ModelSettings {
  FileReferences: {
    Expressions?: { Name: string; File: string }[];
    Motions?: Record<string, { File: string }[]>;
  };
}

// 引擎内部的 Cubism 模型没有导出类型，这里只描述用到的几个方法
interface CoreModel {
  getModel(): { parameters: { ids: string[]; defaultValues: Float32Array | number[] } };
  setParameterValueByIndex(index: number, value: number, weight?: number): void;
  addParameterValueByIndex(index: number, value: number, weight?: number): void;
  multiplyParameterValueByIndex(index: number, value: number, weight?: number): void;
}

const getJson = <T>(url: string | URL): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);

export class Live2DPet {
  canvas: HTMLCanvasElement;
  base = 'idle';
  talking = false;
  layers = new Map<LayerKey, { looks: string[]; until: number }>();
  outfitLooks: string[] = [];
  slots: ExpressionSlot[] = [];
  slotOf = new Map<string, string>();
  mouth = 0;
  weights = new Map<string, number>();
  topY = 0;
  sounds: Sounds = {};
  notes = false;
  notesW = 0;
  lipSync: (() => number | null) | null = null;
  profile!: Live2DProfile;
  app?: Application;
  // 第三方引擎的模型对象：类型声明不全，按 any 处理
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model?: any;
  private pixel = new Uint8Array(4);
  private expressions = new Map<string, ExpressionParam[]>();
  private motionParams = new Map<string, string[]>();
  private paramIndex = new Map<string, number>();
  private paramDefaults: ArrayLike<number> = [];
  private noteConf?: { slot: string; looks: string[]; sweep?: Sweep; clears?: string };
  private currentMotion: string | null = null;
  private reset: { ids: string[]; start: number } | null = null;
  private measureTimer?: ReturnType<typeof setTimeout>;
  private motionTimer?: ReturnType<typeof setTimeout>;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async load(modelUrl: string, profile: Live2DProfile): Promise<void> {
    this.profile = profile;
    extensions.add(Live2DPlugin);

    this.app = new Application();
    await this.app.init({
      canvas: this.canvas,
      resizeTo: window,
      preference: 'webgl',
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      preserveDrawingBuffer: true,
    });

    this.model = await Live2DModel.from(modelUrl, { autoFocus: false, autoHitTest: false });
    this.app.stage.addChild(this.model);
    this.layout();
    window.addEventListener('resize', () => this.layout());

    await this.loadExpressions(modelUrl);
    await this.loadSlots(modelUrl);
    await this.loadMotionParams(modelUrl);
    const core = this.model.internalModel.coreModel as CoreModel;
    const { ids, defaultValues } = core.getModel().parameters;
    this.paramIndex = new Map(ids.map((id, i) => [id, i]));
    this.paramDefaults = defaultValues;
    this.model.internalModel.on('afterMotionUpdate', () => this.applyMotionReset(core));
    this.model.internalModel.on('beforeModelUpdate', () => this.applyParams(core));
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    await new Promise((resolve) => setTimeout(resolve, MEASURE_DELAY));
    this.measureTop();
  }

  // 解析 model3.json 中的全部表情文件，自己按帧叠加（引擎自带的表情管理器同时只能有一个）
  private async loadExpressions(modelUrl: string) {
    const settings = await getJson<ModelSettings>(modelUrl);
    this.expressions = new Map();
    for (const { Name, File } of settings.FileReferences.Expressions || []) {
      const exp = await getJson<{ Parameters?: ExpressionParam[] }>(new URL(File, modelUrl));
      this.expressions.set(Name, exp.Parameters || []);
    }
  }

  // 引擎每帧把动作写入的参数存档，动作停了参数也不会自己回去（蛋包饭会一直摆在桌上），
  // 所以记下每个动作独有的参数，停下时淡回默认值
  private async loadMotionParams(modelUrl: string) {
    const settings = await getJson<ModelSettings>(modelUrl);
    const curves = new Map<string, Set<string>>();
    for (const [group, list] of Object.entries(settings.FileReferences.Motions || {})) {
      const motion = await getJson<{ Curves: { Id: string }[] }>(new URL(list[0].File, modelUrl));
      curves.set(group, new Set(motion.Curves.map((c) => c.Id)));
    }
    const idle = curves.get('Idle') || new Set<string>();
    this.motionParams = new Map([...curves].map(([group, ids]) => [group, [...ids].filter((id) => !idle.has(id))]));
  }

  // pet.json 的 expressionSlots：同一槽位的表情驱动同一块美术，只能亮一个
  private async loadSlots(modelUrl: string) {
    try {
      const pet = await getJson<{ live2d?: { expressionSlots?: ExpressionSlot[]; sounds?: Sounds } }>(
        new URL('pet.json', modelUrl),
      );
      this.slots = pet.live2d?.expressionSlots || [];
      this.sounds = pet.live2d?.sounds || {};
    } catch {
      this.slots = [];
    }
    for (const slot of this.slots) {
      for (const opt of slot.options) for (const name of opt.expressions || []) this.slotOf.set(name, slot.id);
    }
    const { option, clears } = this.profile.notes || {};
    for (const slot of this.slots) {
      const opt = slot.options.find((o) => o.label === option);
      if (opt) this.noteConf = { slot: slot.id, looks: opt.expressions || [], sweep: opt.sweep, clears };
    }
  }

  layout(): void {
    const m = this.model;
    m.scale.set(1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = Math.min((w * 0.86) / m.width, (h * 0.8) / m.height);
    m.scale.set(scale);
    m.anchor.set(0.5, 1);
    m.position.set(w / 2, h - BOTTOM_MARGIN);
    this.topY = h - BOTTOM_MARGIN - m.height;
    this.remeasure();
  }

  remeasure(): void {
    clearTimeout(this.measureTimer);
    this.measureTimer = setTimeout(() => this.measureTop(), MEASURE_DELAY);
  }

  // 模型包围盒顶部有大片透明区域，直接扫描画布找到最高的不透明像素
  measureTop(): void {
    const gl = this.gl();
    if (!gl || !this.app) return;
    const { width, height } = this.canvas;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const rowBytes = width * 4;
    for (let row = height - 1; row >= 0; row--) {
      for (let i = row * rowBytes + 3, end = i + rowBytes; i < end; i += 8) {
        if (pixels[i] > 10) {
          this.topY = (height - 1 - row) / this.app.renderer.resolution;
          return;
        }
      }
    }
  }

  private gl(): WebGLRenderingContext | undefined {
    return (this.app?.renderer as { gl?: WebGLRenderingContext } | undefined)?.gl;
  }

  // ---------- 状态与表情层 ----------

  setBase(state: string): void {
    this.base = state;
  }

  setTalking(talking: boolean): void {
    this.talking = talking;
    this.base = talking ? 'talking' : 'idle';
  }

  react(emotion: string): void {
    if (emotion === 'thinking') return this.setBase('thinking');
    if (emotion === 'neutral') return void this.setLayer('emotion', null);
    const conf = this.profile.emotions[emotion];
    if (!conf) return;
    this.setLayer('emotion', conf.looks, EMOTION_HOLD);
    if (conf.motion) this.motion(conf.motion, conf.secs);
  }

  setLayer(key: LayerKey, looks: string[] | null | undefined, seconds?: number): void {
    if (!looks?.length) {
      this.layers.delete(key);
      return;
    }
    this.layers.set(key, { looks, until: seconds ? performance.now() / 1000 + seconds : Infinity });
  }

  flash(look: string, seconds = FLASH_HOLD): void {
    this.setLayer('flash', [look], seconds);
  }

  setHover(look: string | null | undefined): void {
    this.setLayer('hover', look ? [look] : null);
  }

  isLit(name: string): boolean {
    return (this.weights.get(name) || 0) > 0.5;
  }

  // 边回答边在小本本上写字
  setNotes(on: boolean): void {
    this.notes = !!on && !!this.noteConf;
  }

  // fn() 返回 0~1 的音量（正在播语音）或 null（没有语音，说话时用正弦口型）
  setLipSync(fn: () => number | null): void {
    this.lipSync = fn;
  }

  // outfit：{ 槽位 id: 选项 label }，对应 pet.json 里该选项的 expressions
  setOutfit(outfit: Outfit = {}): void {
    this.outfitLooks = this.slots.flatMap((slot) => {
      const opt = outfit[slot.id] && slot.options.find((o) => o.label === outfit[slot.id]);
      return opt ? opt.expressions || [] : [];
    });
    this.remeasure();
  }

  // 动作文件都标了 Loop，这里循环播放 secs 秒后淡回待机
  motion(name: string, secs = 4): void {
    clearTimeout(this.motionTimer);
    const next = new Set(this.motionParams.get(name) || []);
    this.resetParams(this.leftoverParams().filter((id) => !next.has(id)));
    this.currentMotion = name;
    this.model.motion(name, 0, 3, { loop: true });
    this.motionTimer = setTimeout(() => this.stopMotion(), secs * 1000);
  }

  stopMotion(): void {
    clearTimeout(this.motionTimer);
    this.resetParams(this.leftoverParams());
    this.currentMotion = null;
    this.model.motion('Idle', 0, 3);
  }

  private leftoverParams(): string[] {
    return [...((this.currentMotion && this.motionParams.get(this.currentMotion)) || []), ...(this.reset?.ids || [])];
  }

  private resetParams(ids: string[]) {
    this.reset = ids.length ? { ids: [...new Set(ids)], start: performance.now() } : null;
  }

  private applyMotionReset(core: CoreModel) {
    if (!this.reset) return;
    const w = Math.min(1, (performance.now() - this.reset.start) / 400);
    for (const id of this.reset.ids) {
      const idx = this.paramIndex.get(id);
      if (idx != null) core.setParameterValueByIndex(idx, this.paramDefaults[idx], w);
    }
    if (w >= 1) this.reset = null;
  }

  setPointer(clientX: number, clientY: number): void {
    this.model?.focus(clientX, clientY);
  }

  // 屏幕坐标 → 模型包围盒内的比例坐标
  private frac(clientX: number, clientY: number) {
    const m = this.model;
    return {
      fx: (clientX - (m.x - m.width * m.anchor.x)) / m.width,
      fy: (clientY - (m.y - m.height * m.anchor.y)) / m.height,
    };
  }

  zoneAt(clientX: number, clientY: number): string | null {
    if (!this.model) return null;
    const { fx, fy } = this.frac(clientX, clientY);
    const zone = this.profile.zones.find(
      (z) => (!z.when || this.isLit(z.when)) && ((fx - z.x) / z.rx) ** 2 + ((fy - z.y) / z.ry) ** 2 <= 1,
    );
    return zone?.id || null;
  }

  hitTest(clientX: number, clientY: number): boolean {
    const gl = this.gl();
    if (!gl || !this.app) return false;
    const ratio = this.app.renderer.resolution;
    const x = Math.floor(clientX * ratio);
    const y = Math.floor(this.canvas.height - clientY * ratio);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return false;
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    return this.pixel[3] > 10;
  }

  propAt(clientX: number, clientY: number): string | null {
    const m = this.model;
    const { props, propRadius, propBlockers } = this.profile;
    if (!m || !props || propBlockers.some((name) => (this.weights.get(name) || 0) > 0.3)) return null;
    const { fx, fy } = this.frac(clientX, clientY);
    for (const [id, p] of Object.entries(props)) {
      if (((fx - p.x) / propRadius.x) ** 2 + ((fy - p.y) / propRadius.y) ** 2 <= 1) return id;
    }
    return null;
  }

  // ---------- 每帧 ----------

  private activeLooks(): Set<string> {
    const now = performance.now() / 1000;
    const bySlot = new Map<string, string[]>();
    const put = (looks: string[]) => {
      const group = new Map<string, string[]>();
      for (const name of looks) {
        const slot = this.slotOf.get(name) ?? name;
        group.set(slot, [...(group.get(slot) || []), name]);
      }
      for (const [slot, names] of group) bySlot.set(slot, names);
    };
    put(this.outfitLooks);
    put(this.profile.states[this.base] || []);
    for (const key of LAYER_ORDER) {
      const layer = this.layers.get(key);
      if (layer && now > layer.until) this.layers.delete(key);
      else if (layer) put(layer.looks);
    }
    if (this.notes && this.noteConf) {
      if (this.noteConf.clears) bySlot.delete(this.noteConf.clears);
      bySlot.set(this.noteConf.slot, this.noteConf.looks);
    }
    return new Set([...bySlot.values()].flat());
  }

  private tick(dt: number) {
    const active = this.activeLooks();
    const k = 1 - Math.exp(-dt * FADE_SPEED);
    for (const name of new Set([...this.weights.keys(), ...active])) {
      const w = (this.weights.get(name) || 0) + ((active.has(name) ? 1 : 0) - (this.weights.get(name) || 0)) * k;
      if (w < 0.001 && !active.has(name)) this.weights.delete(name);
      else this.weights.set(name, w);
    }
    this.notesW += ((this.notes ? 1 : 0) - this.notesW) * k;
    const t = performance.now() / 1000;
    const level = this.lipSync?.();
    const target = level != null ? level : this.talking ? 0.5 + 0.45 * Math.sin(t * 17) * Math.sin(t * 7.3) : 0;
    const speed = target > this.mouth ? 30 : 14;
    this.mouth += (Math.max(0, Math.min(1, target)) - this.mouth) * (1 - Math.exp(-dt * speed));
  }

  // pet.json 的 sweep：手在本子上来回划，笔尖一下一下点着纸
  private sweepValues(t: number): Record<string, number> {
    const s = this.noteConf?.sweep;
    if (!s) return {};
    const p = (2 * Math.PI * t * 1000) / s.loopMs;
    const drift = Math.sin((2 * Math.PI * t * 1000) / s.driftMs);
    return {
      [s.x]: s.ampX * Math.sin(p),
      [s.y]: s.ampY * Math.sin(2 * p) * 0.5 + s.driftY * drift,
      [s.rz]: s.ampZ * Math.sin(p + Math.PI / 2),
      [s.z]: 0.5 + 0.5 * Math.sin(4 * p),
    };
  }

  private applyParams(core: CoreModel) {
    for (const [name, w] of this.weights) {
      for (const p of this.expressions.get(name) || []) {
        const idx = this.paramIndex.get(p.Id);
        if (idx == null) continue;
        if (p.Blend === 'Add') core.addParameterValueByIndex(idx, p.Value, w);
        else if (p.Blend === 'Multiply') core.multiplyParameterValueByIndex(idx, p.Value, w);
        else core.setParameterValueByIndex(idx, p.Value, w);
      }
    }
    if (this.notesW > 0.01) {
      for (const [id, v] of Object.entries(this.sweepValues(performance.now() / 1000))) {
        const idx = this.paramIndex.get(id);
        if (idx != null) core.setParameterValueByIndex(idx, v, this.notesW);
      }
    }
    const mouthIdx = this.paramIndex.get(this.profile.mouthParam);
    if (mouthIdx != null && this.mouth > 0.01) core.setParameterValueByIndex(mouthIdx, this.mouth);
  }
}

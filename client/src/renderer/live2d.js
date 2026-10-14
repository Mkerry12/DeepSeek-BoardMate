// Live2D 角色（Cubism 3/4/5）：setBase / setTalking / react / setLayer / flash / motion / setOutfit / propAt / hitTest / topY
// 引擎在导入时就要求 window.Live2DCubismCore 存在，所以本模块必须在 Core 加载后再动态导入
import { Application, extensions } from 'pixi.js';
import { Live2DModel, Live2DPlugin } from 'untitled-pixi-live2d-engine/cubism';

const BOTTOM_MARGIN = 6;
const FADE_SPEED = 8;
const EMOTION_HOLD = 6;
const FLASH_HOLD = 2.5;
const MEASURE_DELAY = 1200;
// 同一槽位里后面的层覆盖前面的层（例如挥手的「双手比耶」暂时替换换装的「喵喵手」）
const LAYER_ORDER = ['activity', 'emotion', 'flash', 'hover'];

// 角色包里的 live2d.json 未提供时使用的默认映射（按 DS 鲸鱼娘的表情名）
const DEFAULT_PROFILE = {
  states: {
    thinking: ['画笔', '问号'],
    queued: ['感叹号'],
  },
  emotions: {
    happy: { looks: ['开心兴奋', '情绪花花', '脸红'] },
    wave: { looks: ['双手比耶', '开心兴奋'], motion: 'SprayWater', secs: 2 },
    sad: { looks: ['悲伤', '流汗'] },
    angry: { looks: ['生气'], motion: 'Hammer', secs: 4.8 },
    surprised: { looks: ['感叹号', '星星眼'] },
    relaxed: { looks: ['调皮', '脸红'] },
  },
  // 桌上纸张里的三个图标：中心与半径都按模型包围盒的比例给出，任意缩放下都成立
  props: {
    undo: { look: '撤回', x: 0.327, y: 0.794 },
    brush: { look: '画笔', x: 0.445, y: 0.796 },
    eraser: { look: '橡皮', x: 0.569, y: 0.799 },
  },
  propRadius: { x: 0.05, y: 0.034 },
  propBlockers: ['蛋包饭'],
  mouthParam: 'ParamMouthOpenY',
};

export class Live2DPet {
  constructor(canvas) {
    this.canvas = canvas;
    this.base = 'idle';
    this.talking = false;
    this.layers = new Map();
    this.outfitLooks = [];
    this.slots = [];
    this.slotOf = new Map();
    this.mouth = 0;
    this.weights = new Map();
    this.topY = 0;
    this._pixel = new Uint8Array(4);
  }

  async load(modelUrl, profile = DEFAULT_PROFILE) {
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
    const core = this.model.internalModel.coreModel;
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
  async loadExpressions(modelUrl) {
    const settings = await fetch(modelUrl).then((r) => r.json());
    this.expressions = new Map();
    for (const { Name, File } of settings.FileReferences.Expressions || []) {
      const exp = await fetch(new URL(File, modelUrl)).then((r) => r.json());
      this.expressions.set(Name, exp.Parameters || []);
    }
  }

  // 引擎每帧把动作写入的参数存档，动作停了参数也不会自己回去（蛋包饭会一直摆在桌上），
  // 所以记下每个动作独有的参数，停下时淡回默认值
  async loadMotionParams(modelUrl) {
    const settings = await fetch(modelUrl).then((r) => r.json());
    const curves = new Map();
    for (const [group, list] of Object.entries(settings.FileReferences.Motions || {})) {
      const motion = await fetch(new URL(list[0].File, modelUrl)).then((r) => r.json());
      curves.set(group, new Set(motion.Curves.map((c) => c.Id)));
    }
    const idle = curves.get('Idle') || new Set();
    this.motionParams = new Map([...curves].map(([group, ids]) => [group, [...ids].filter((id) => !idle.has(id))]));
  }

  // pet.json 的 expressionSlots：同一槽位的表情驱动同一块美术，只能亮一个
  async loadSlots(modelUrl) {
    try {
      const pet = await fetch(new URL('pet.json', modelUrl)).then((r) => r.json());
      this.slots = pet.live2d?.expressionSlots || [];
    } catch {
      this.slots = [];
    }
    for (const slot of this.slots) {
      for (const opt of slot.options) for (const name of opt.expressions || []) this.slotOf.set(name, slot.id);
    }
  }

  layout() {
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

  remeasure() {
    clearTimeout(this._measureTimer);
    this._measureTimer = setTimeout(() => this.measureTop(), MEASURE_DELAY);
  }

  // 模型包围盒头顶上方有大片透明区域，直接扫描画布找到最上方的不透明像素行
  measureTop() {
    const gl = this.app?.renderer.gl;
    if (!gl) return;
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

  // ---------- 状态与表情层 ----------

  setBase(state) {
    this.base = state;
  }

  setTalking(talking) {
    this.talking = talking;
    this.base = talking ? 'talking' : 'idle';
  }

  react(emotion) {
    if (emotion === 'thinking') return this.setBase('thinking');
    if (emotion === 'neutral') return this.setLayer('emotion', null);
    const conf = this.profile.emotions[emotion];
    if (!conf) return;
    this.setLayer('emotion', conf.looks, EMOTION_HOLD);
    if (conf.motion) this.motion(conf.motion, conf.secs);
  }

  setLayer(key, looks, seconds) {
    if (!looks?.length) return this.layers.delete(key);
    this.layers.set(key, { looks, until: seconds ? performance.now() / 1000 + seconds : Infinity });
  }

  flash(look, seconds = FLASH_HOLD) {
    this.setLayer('flash', [look], seconds);
  }

  setHover(look) {
    this.setLayer('hover', look && [look]);
  }

  // outfit：{ 槽位 id: 选项 label }，对应 pet.json 里该选项的 expressions
  setOutfit(outfit = {}) {
    this.outfitLooks = this.slots.flatMap((slot) => {
      const opt = outfit[slot.id] && slot.options.find((o) => o.label === outfit[slot.id]);
      return opt?.expressions || [];
    });
    this.remeasure();
  }

  // 动作文件都标了 Loop，这里循环播放 secs 秒后淡回待机
  motion(name, secs = 4) {
    clearTimeout(this._motionTimer);
    const next = new Set(this.motionParams.get(name) || []);
    this.resetParams(this.leftoverParams().filter((id) => !next.has(id)));
    this.currentMotion = name;
    this.model.motion(name, 0, 3, { loop: true });
    this._motionTimer = setTimeout(() => this.stopMotion(), secs * 1000);
  }

  stopMotion() {
    clearTimeout(this._motionTimer);
    this.resetParams(this.leftoverParams());
    this.currentMotion = null;
    this.model.motion('Idle', 0, 3);
  }

  leftoverParams() {
    return [...(this.motionParams.get(this.currentMotion) || []), ...(this.reset?.ids || [])];
  }

  resetParams(ids) {
    this.reset = ids.length ? { ids: [...new Set(ids)], start: performance.now() } : null;
  }

  applyMotionReset(core) {
    if (!this.reset) return;
    const w = Math.min(1, (performance.now() - this.reset.start) / 400);
    for (const id of this.reset.ids) {
      const idx = this.paramIndex.get(id);
      if (idx != null) core.setParameterValueByIndex(idx, this.paramDefaults[idx], w);
    }
    if (w >= 1) this.reset = null;
  }

  setPointer(clientX, clientY) {
    this.model?.focus(clientX, clientY);
  }

  hitTest(clientX, clientY) {
    const gl = this.app?.renderer.gl;
    if (!gl) return false;
    const ratio = this.app.renderer.resolution;
    const x = Math.floor(clientX * ratio);
    const y = Math.floor(this.canvas.height - clientY * ratio);
    if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) return false;
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._pixel);
    return this._pixel[3] > 10;
  }

  propAt(clientX, clientY) {
    const m = this.model;
    const { props, propRadius, propBlockers } = this.profile;
    if (!m || !props || propBlockers.some((name) => (this.weights.get(name) || 0) > 0.3)) return null;
    const fx = (clientX - (m.x - m.width * m.anchor.x)) / m.width;
    const fy = (clientY - (m.y - m.height * m.anchor.y)) / m.height;
    for (const [id, p] of Object.entries(props)) {
      if (((fx - p.x) / propRadius.x) ** 2 + ((fy - p.y) / propRadius.y) ** 2 <= 1) return id;
    }
    return null;
  }

  // ---------- 每帧 ----------

  activeLooks() {
    const now = performance.now() / 1000;
    const bySlot = new Map();
    const put = (looks) => {
      const group = new Map();
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
    return new Set([...bySlot.values()].flat());
  }

  tick(dt) {
    const active = this.activeLooks();
    const k = 1 - Math.exp(-dt * FADE_SPEED);
    for (const name of new Set([...this.weights.keys(), ...active])) {
      const w = (this.weights.get(name) || 0) + ((active.has(name) ? 1 : 0) - (this.weights.get(name) || 0)) * k;
      if (w < 0.001 && !active.has(name)) this.weights.delete(name);
      else this.weights.set(name, w);
    }

    const t = performance.now() / 1000;
    const target = this.talking ? 0.5 + 0.45 * Math.sin(t * 17) * Math.sin(t * 7.3) : 0;
    this.mouth += (Math.max(0, target) - this.mouth) * (1 - Math.exp(-dt * 20));
  }

  applyParams(core) {
    for (const [name, w] of this.weights) {
      for (const p of this.expressions.get(name) || []) {
        const idx = this.paramIndex.get(p.Id);
        if (idx == null) continue;
        if (p.Blend === 'Add') core.addParameterValueByIndex(idx, p.Value, w);
        else if (p.Blend === 'Multiply') core.multiplyParameterValueByIndex(idx, p.Value, w);
        else core.setParameterValueByIndex(idx, p.Value, w);
      }
    }
    const mouthIdx = this.paramIndex.get(this.profile.mouthParam);
    if (mouthIdx != null && this.mouth > 0.01) core.setParameterValueByIndex(mouthIdx, this.mouth);
  }
}

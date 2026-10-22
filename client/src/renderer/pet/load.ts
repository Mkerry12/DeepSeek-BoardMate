// 加载角色：Cubism Core（专有，经典脚本）→ 动态导入 Live2D 引擎 → 读模型和角色配置
// 引擎在导入时就要求 window.Live2DCubismCore 存在，所以 ./live2d 只能在 Core 加载后动态导入；
// Vite 会把它和 pixi.js / 引擎一起拆成单独的 chunk，入口脚本里不会提前执行
import { loadConfig, type CharacterConfig } from '../character/config';
import type { Live2DPet } from './live2d';

// vendor/ 是渲染进程的 publicDir：开发时由 Vite 提供，构建时复制到 out/renderer/
const CUBISM_CORE = './live2dcubismcore.min.js';

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`缺少 ${src.split('/').pop()}`));
    document.head.appendChild(script);
  });
}

export async function loadPet(canvas: HTMLCanvasElement): Promise<{ pet: Live2DPet; character: CharacterConfig }> {
  const modelUrl = await window.desk.getModelUrl();
  const character = await loadConfig(modelUrl);
  await loadScript(CUBISM_CORE);
  const { Live2DPet } = await import('./live2d');
  const pet = new Live2DPet(canvas);
  await pet.load(modelUrl, character.live2d);
  return { pet, character };
}

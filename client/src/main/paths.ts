import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 打包后模型等资源在 resources/assets（electron-builder extraResources），开发时在 client/assets
export const ASSETS_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(app.getAppPath(), 'assets');
export const MODEL_DIR = path.join(ASSETS_DIR, 'live2d', 'ds-whale-girl');
export const ICON = path.join(ASSETS_DIR, 'icon.png');
// Windows 托盘/窗口用多尺寸 ico，系统按 DPI 选最合适的一档
export const WIN_ICON = path.join(ASSETS_DIR, 'icon.ico');
export const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
export const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
/** electron-vite dev 时渲染进程由 Vite 开发服务器提供 */
export const RENDERER_DEV_URL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;

export const userFile = (name: string): string => path.join(app.getPath('userData'), name);

// 渲染进程按这个地址加载模型：打包后是 file://；开发时页面来自 http://localhost，
// 不能读 file://，改走 Vite 的 /@fs/（client/ 在 Vite 的允许列表里）
export function modelUrl(): string {
  const file = fs.readdirSync(MODEL_DIR).find((f) => f.endsWith('.model3.json'));
  if (!file) throw new Error(`${MODEL_DIR} 里没有 .model3.json`);
  const full = path.join(MODEL_DIR, file);
  if (RENDERER_DEV_URL) return new URL(`/@fs/${full.replace(/\\/g, '/')}`, RENDERER_DEV_URL).href;
  return pathToFileURL(full).href;
}

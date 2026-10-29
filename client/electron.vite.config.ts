import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import { buildDefines } from './build-env';

const root = __dirname;

export default defineConfig({
  // 主进程 / preload：dependencies（msedge-tts、electron-updater）不打包，由 electron-builder 放进 app.asar 的 node_modules
  main: {
    // 官方服务器地址：构建时读环境变量 DESKMATE_SERVER_URL（见 build-env.ts）
    define: buildDefines(),
    build: { rollupOptions: { input: resolve(root, 'src/main/index.ts') } },
  },
  // preload 跑在沙箱里，只能 require('electron')，共享代码会被打包进来
  preload: {
    build: { rollupOptions: { input: resolve(root, 'src/preload/index.ts') } },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    // Live2D Cubism Core（专有、gitignore）以经典脚本加载：开发时由 Vite 从 vendor/ 提供，构建时复制到 out/renderer/
    publicDir: resolve(root, 'vendor'),
    server: {
      // 固定 IPv4：localhost 在 Windows 上可能只绑到 ::1
      host: '127.0.0.1',
      // /@fs/ 加载 client/assets 里的模型；shared/ 是和服务器共用的情绪标签表
      fs: { allow: [root, resolve(root, '../shared')] },
    },
    build: {
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
      // electron-vite 默认不压缩渲染进程代码；压缩后 pixi.js / Live2D 引擎体积少一半多，加载更快
      minify: true,
      // 引擎 + pixi.js 体积大，单独的 chunk 本来就要等 Cubism Core 加载后才动态导入
      chunkSizeWarningLimit: 2000,
    },
  },
});

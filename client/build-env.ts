// 构建时注入的常量，electron.vite.config.ts 和 vitest.config.mts 共用
// 「官方服务器」默认地址；打包时可用环境变量 DESKMATE_SERVER_URL 覆盖（开发 / 测试 / 正式各用各的）
export const DEFAULT_SERVER_URL = 'http://5f8c344a.r15.cpolar.top';

export function buildDefines(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const url = (env.DESKMATE_SERVER_URL || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
  return { __DESKMATE_SERVER_URL__: JSON.stringify(url) };
}

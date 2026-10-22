// 极简的 JSON 校验器：校验失败时抛出带路径的错误，例如 `idle.activities[2].secs 应为数字`
export type Check<T> = (value: unknown, path: string) => T;

export class ConfigError extends Error {}

const fail = (path: string, what: string): never => {
  throw new ConfigError(`${path || '(根)'} 应为${what}`);
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export const str: Check<string> = (v, p) => (typeof v === 'string' ? v : fail(p, '字符串'));

export const num: Check<number> = (v, p) => (typeof v === 'number' && Number.isFinite(v) ? v : fail(p, '数字'));

export const arr =
  <T>(item: Check<T>, { min = 0 } = {}): Check<T[]> =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, '数组');
    if (v.length < min) return fail(p, `至少 ${min} 项的数组`);
    return v.map((x, i) => item(x, `${p}[${i}]`));
  };

export const tuple =
  <A, B>(a: Check<A>, b: Check<B>): Check<[A, B]> =>
  (v, p) => {
    if (!Array.isArray(v) || v.length !== 2) return fail(p, '两项的数组');
    return [a(v[0], `${p}[0]`), b(v[1], `${p}[1]`)];
  };

export const record =
  <T>(item: Check<T>): Check<Record<string, T>> =>
  (v, p) => {
    if (!isObject(v)) return fail(p, '对象');
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, item(x, `${p}.${k}`)]));
  };

/** 字段后缀 ? 表示可选，例如 { 'motion?': str } */
type Shape = Record<string, Check<unknown>>;
type Req<S> = { [K in keyof S as K extends `${string}?` ? never : K]: S[K] extends Check<infer T> ? T : never };
type Opt<S> = {
  [K in keyof S as K extends `${infer N}?` ? N : never]?: S[K] extends Check<infer T> ? T : never;
};
export type Infer<S> = Req<S> & Opt<S>;

export const obj =
  <S extends Shape>(shape: S): Check<Infer<S>> =>
  (v, p) => {
    if (!isObject(v)) return fail(p, '对象');
    const out: Record<string, unknown> = { ...v };
    for (const [rawKey, check] of Object.entries(shape)) {
      const optional = rawKey.endsWith('?');
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      const path = p ? `${p}.${key}` : key;
      if (v[key] === undefined) {
        if (!optional) fail(path, '必填项');
        continue;
      }
      out[key] = check(v[key], path);
    }
    return out as Infer<S>;
  };

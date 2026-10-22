export const pickOne = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

export const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}…` : text);

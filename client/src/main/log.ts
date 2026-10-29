// 极简文件日志：%APPDATA%\deepseek-deskmate\logs\main.log（超过 1 MB 时轮换一份 .old）
import fs from 'node:fs';
import path from 'node:path';
import { userFile } from './paths';

const MAX_BYTES = 1024 * 1024;

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

function format(level: string, args: unknown[]): string {
  const text = args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ');
  return `${new Date().toISOString()} [${level}] ${text}\n`;
}

export function createFileLogger(file: string, scope: string): Logger {
  const write = (level: string, args: unknown[]) => {
    const line = format(level, [`[${scope}]`, ...args]);
    if (level !== 'debug') console.log(line.trimEnd());
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, line);
    } catch {}
  };
  return {
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    debug: (...a) => write('debug', a),
  };
}

export const logFile = (): string => userFile(path.join('logs', 'main.log'));

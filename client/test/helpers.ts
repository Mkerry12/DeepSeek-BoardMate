import raw from '../assets/live2d/ds-whale-girl/deskmate.json';
import { validateConfig } from '../src/renderer/character/config';

/** 仓库里真实的角色配置（测试顺便保证它能通过校验） */
export const rawCharacter: unknown = raw;
export const character = validateConfig(raw);

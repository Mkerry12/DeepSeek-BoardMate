import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERNAL_EMOTIONS, validateConfig } from '../src/renderer/character/config';
import { DEFAULT_PERSONA, MEMORY_PROMPT, REPLY_RULES } from '../src/renderer/lib/persona';
import { StreamFilter } from '../src/renderer/lib/stream-filter';
import { EMOTION_TAGS, STATE_TAGS } from '../src/shared/emotions';
import { character, rawCharacter } from './helpers';

const clone = (): Record<string, any> => structuredClone(rawCharacter) as Record<string, any>;

describe('character config (deskmate.json)', () => {
  it('the bundled character passes validation', () => {
    expect(character.name).toBe('小鲸');
    expect(character.live2d.zones.length).toBeGreaterThan(0);
  });

  it('every character folder under assets/live2d has a valid deskmate.json', () => {
    const base = path.join(__dirname, '..', 'assets', 'live2d');
    const folders = fs.readdirSync(base).filter((f) => fs.statSync(path.join(base, f)).isDirectory());
    expect(folders.length).toBeGreaterThan(0);
    for (const f of folders) {
      const raw = JSON.parse(fs.readFileSync(path.join(base, f, 'deskmate.json'), 'utf8'));
      expect(() => validateConfig(raw), f).not.toThrow();
    }
  });

  it('reports the path of a wrong type', () => {
    const c = clone();
    c.idle.activities[2].secs = 'ten';
    expect(() => validateConfig(c)).toThrow('idle.activities[2].secs 应为数字');
  });

  it('reports a missing required field', () => {
    const c = clone();
    delete c.fortune.colors;
    expect(() => validateConfig(c)).toThrow('fortune.colors 应为必填项');
  });

  it('rejects empty line lists and malformed tuples', () => {
    const c = clone();
    c.clickLines = [];
    expect(() => validateConfig(c)).toThrow('clickLines 应为至少 1 项的数组');
    const d = clone();
    d.greetings[0].from = [8];
    expect(() => validateConfig(d)).toThrow('greetings[0].from 应为两项的数组');
  });

  it('requires every reply tag and internal emotion to be mapped', () => {
    const c = clone();
    delete c.live2d.emotions.sleepy;
    delete c.live2d.emotions.soulout;
    expect(() => validateConfig(c)).toThrow('live2d.emotions 缺少情绪：sleepy, soulout');
  });

  it('rejects references to unknown emotions', () => {
    const c = clone();
    c.fortune.levels[0].emotion = 'ecstatic';
    expect(() => validateConfig(c)).toThrow('ecstatic');
  });

  it('rejects an unsupported config version', () => {
    const c = clone();
    c.configVersion = 2;
    expect(() => validateConfig(c)).toThrow('configVersion');
  });

  it('keeps unknown extra fields (forward compatible)', () => {
    const c = clone();
    c.extra = { future: true };
    expect((validateConfig(c) as unknown as { extra: unknown }).extra).toEqual({ future: true });
  });
});

describe('emotion tags stay consistent with the server', () => {
  const shared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'emotion-tags.json'), 'utf8'));
  const serverRoot = path.join(__dirname, '..', '..', 'server');

  it('client tags come from shared/emotion-tags.json', () => {
    expect(EMOTION_TAGS).toEqual(shared.tags);
  });

  it('server prompt text matches the client copy (tags themselves come from the shared file)', () => {
    const src = fs.readFileSync(path.join(serverRoot, 'deskmate_server', 'persona.py'), 'utf8').replace(/\r/g, '');
    expect(src).toContain('emotion-tags.json');
    expect(src).toContain(DEFAULT_PERSONA);
    expect(src).toContain(MEMORY_PROMPT);
    const start = src.indexOf('REPLY_RULES = f"""') + 'REPLY_RULES = f"""'.length;
    const serverRules = src.slice(start, src.indexOf('"""', start));
    const clientRules = REPLY_RULES.split('\n');
    expect(serverRules.split('\n').filter((l) => !l.includes('只能是以下之一'))).toEqual(
      clientRules.filter((l) => !l.includes('只能是以下之一')),
    );
  });

  it('client REPLY_RULES lists every tag', () => {
    expect(REPLY_RULES).toContain(EMOTION_TAGS.map((t) => `[${t}]`).join(' '));
  });

  it('client stream filter accepts every tag and nothing else', () => {
    for (const tag of EMOTION_TAGS) {
      const f = new StreamFilter();
      expect(f.feed(`[${tag}]hi`)[0]).toEqual({ type: 'emotion', value: tag });
    }
    expect(new StreamFilter().feed('[soulout]hi')[0]).toEqual({ type: 'delta', text: 'hi' });
  });

  it('the character maps every non-state tag plus internal emotions', () => {
    const needed = [...EMOTION_TAGS.filter((t) => !STATE_TAGS.includes(t)), ...INTERNAL_EMOTIONS];
    for (const tag of needed) expect(character.live2d.emotions[tag], tag).toBeDefined();
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSettingsStore,
  DEFAULT_SETTINGS,
  migrateSettings,
  OFFICIAL_SERVER_URL,
  serializeSettings,
  type KeyCipher,
} from '../src/main/settings';

// 假的「DPAPI」：base64 + 前缀，方便断言
const cipher: KeyCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decrypt: (encoded) => {
    const text = Buffer.from(encoded, 'base64').toString();
    if (!text.startsWith('enc:')) throw new Error('bad');
    return text.slice(4);
  },
};
const noCipher: KeyCipher = { ...cipher, available: () => false };

describe('migrateSettings', () => {
  it('returns full defaults for empty or broken input', () => {
    for (const input of [undefined, null, {}, [], 'oops', 42]) {
      expect(migrateSettings(input, cipher)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('does not share nested objects with DEFAULT_SETTINGS', () => {
    const s = migrateSettings({}, cipher);
    s.voice.on = true;
    s.outfit.glasses = '墨镜';
    expect(DEFAULT_SETTINGS.voice.on).toBe(false);
    expect(DEFAULT_SETTINGS.outfit.glasses).toBeUndefined();
  });

  it('merges nested objects with their defaults', () => {
    const s = migrateSettings({ voice: { on: true }, reminders: { water: { on: false, minutes: 30 } } }, cipher);
    expect(s.voice).toEqual({ ...DEFAULT_SETTINGS.voice, on: true });
    expect(s.reminders.water).toEqual({ on: false, minutes: 30 });
    expect(s.reminders.rest).toEqual(DEFAULT_SETTINGS.reminders.rest);
  });

  it('migrates an old v0.1 settings file with peek / character / modelPath', () => {
    const old = {
      mode: 'official',
      serverUrl: `${OFFICIAL_SERVER_URL}/`,
      token: 'tok',
      character: 'ds-whale-girl',
      modelPath: 'C:/old/model.model3.json',
      peek: true,
      position: { x: -200, y: 300 },
      outfit: { whale: '', glasses: '圆眼镜' },
      api: { preset: 'deepseek', keyEnc: cipher.encrypt('sk-secret'), model: 'deepseek-chat' },
    };
    const s = migrateSettings(old, cipher) as unknown as Record<string, unknown> & typeof DEFAULT_SETTINGS;
    expect(s.position).toBeNull();
    expect('peek' in s).toBe(false);
    expect('character' in s).toBe(false);
    expect('modelPath' in s).toBe(false);
    expect(s.serverUrl).toBe('');
    expect(s.api.key).toBe('sk-secret');
    expect('keyEnc' in s.api).toBe(false);
    expect(s.outfit).toEqual({ whale: '', glasses: '圆眼镜' });
    expect(s.token).toBe('tok');
  });

  it('keeps the position when peek is false', () => {
    expect(migrateSettings({ peek: false, position: { x: 1, y: 2 } }, cipher).position).toEqual({ x: 1, y: 2 });
  });

  it('drops an API key that can no longer be decrypted', () => {
    const s = migrateSettings({ api: { keyEnc: 'garbage' } }, cipher);
    expect(s.api.key).toBe('');
  });
});

describe('serializeSettings', () => {
  it('encrypts the API key when encryption is available', () => {
    const s = migrateSettings({ api: { key: 'sk-1' } }, cipher);
    const out = serializeSettings(s, cipher);
    expect(out.api).not.toHaveProperty('key');
    expect(cipher.decrypt((out.api as { keyEnc: string }).keyEnc)).toBe('sk-1');
  });

  it('falls back to plain text without encryption and omits empty keys', () => {
    const plain = serializeSettings(migrateSettings({ api: { key: 'sk-1' } }, cipher), noCipher);
    expect(plain.api).toMatchObject({ key: 'sk-1' });
    const empty = serializeSettings(migrateSettings({}, cipher), cipher);
    expect(empty.api).not.toHaveProperty('key');
    expect(empty.api).not.toHaveProperty('keyEnc');
  });

  it('round-trips through migrateSettings', () => {
    const s = migrateSettings({ api: { key: 'sk-1' }, persona: '猫娘' }, cipher);
    expect(migrateSettings(JSON.parse(JSON.stringify(serializeSettings(s, cipher))), cipher)).toEqual(s);
  });
});

describe('createSettingsStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskmate-settings-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('patches, normalizes, strips officialServerUrl and persists encrypted', () => {
    const file = path.join(dir, 'settings.json');
    const store = createSettingsStore(file, cipher);
    const view = store.patch({
      serverUrl: OFFICIAL_SERVER_URL,
      officialServerUrl: 'http://evil',
      api: { ...store.get().api, key: 'sk-9' },
    });
    expect(view.officialServerUrl).toBe(OFFICIAL_SERVER_URL);
    expect(view.serverUrl).toBe('');
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(disk.officialServerUrl).toBeUndefined();
    expect(disk.api.key).toBeUndefined();
    expect(createSettingsStore(file, cipher).get().api.key).toBe('sk-9');
  });
});

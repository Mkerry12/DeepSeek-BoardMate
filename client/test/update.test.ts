import { describe, expect, it } from 'vitest';
import { buildDefines, DEFAULT_SERVER_URL } from '../build-env';
import { OFFICIAL_SERVER_URL } from '../src/main/settings';
import {
  checkResultMessage,
  compareVersions,
  installKind,
  updateAnnouncement,
  updateMenuItem,
  type UpdateStatus,
} from '../src/shared/update';

const s = (patch: Partial<UpdateStatus>): UpdateStatus => ({
  state: 'idle',
  kind: 'installer',
  current: '0.2.0',
  ...patch,
});

describe('build-time server URL', () => {
  it('defaults to the official URL and can be overridden by DESKMATE_SERVER_URL', () => {
    expect(OFFICIAL_SERVER_URL).toBe(DEFAULT_SERVER_URL);
    expect(buildDefines({})).toEqual({ __DESKMATE_SERVER_URL__: JSON.stringify(DEFAULT_SERVER_URL) });
    expect(buildDefines({ DESKMATE_SERVER_URL: '' }).__DESKMATE_SERVER_URL__).toBe(JSON.stringify(DEFAULT_SERVER_URL));
    expect(buildDefines({ DESKMATE_SERVER_URL: ' https://test.example.com/ ' }).__DESKMATE_SERVER_URL__).toBe(
      '"https://test.example.com"',
    );
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.2.0', '0.1.9', 1],
    ['v0.2.0', '0.2.0', 0],
    ['0.10.0', '0.9.9', 1],
    ['1.0', '1.0.1', -1],
    ['0.3.0-beta.1', '0.3.0', 0],
    ['1.2.3', 'v1.2.10', -1],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe('installKind', () => {
  it('detects dev, portable and installer builds', () => {
    expect(installKind(false, { PORTABLE_EXECUTABLE_FILE: 'x.exe' })).toBe('dev');
    expect(installKind(true, { PORTABLE_EXECUTABLE_FILE: 'C:/a/DeskMate.exe' })).toBe('portable');
    expect(installKind(true, {})).toBe('installer');
  });
});

describe('updateAnnouncement', () => {
  it('speaks once when an installer update is downloaded', () => {
    const ready = s({ state: 'ready', version: '0.3.0' });
    expect(updateAnnouncement(s({ state: 'downloading', version: '0.3.0' }), ready)).toBe('有新版本啦，重启就能用上～');
    expect(updateAnnouncement(ready, { ...ready })).toBeNull();
  });

  it('tells portable users to download', () => {
    const msg = updateAnnouncement(null, s({ kind: 'portable', state: 'available', version: '0.3.0' }));
    expect(msg).toContain('v0.3.0');
  });

  it('stays quiet for checking / latest / errors', () => {
    for (const state of ['checking', 'latest', 'error', 'downloading', 'disabled'] as const) {
      expect(updateAnnouncement(null, s({ state }))).toBeNull();
    }
  });
});

describe('updateMenuItem / checkResultMessage', () => {
  it('maps states to menu actions', () => {
    expect(updateMenuItem(s({ state: 'ready', version: '0.3.0' }))).toMatchObject({
      label: '重启并更新',
      action: 'install',
    });
    expect(updateMenuItem(s({ state: 'available', version: '0.3.0' })).action).toBe('open-page');
    expect(updateMenuItem(s({ state: 'downloading', percent: 41.6 })).hint).toBe('下载中 42%');
    expect(updateMenuItem(s({ state: 'latest' }))).toEqual({ label: '检查更新', action: 'check', hint: 'v0.2.0' });
  });

  it('describes manual check results', () => {
    expect(checkResultMessage(s({ state: 'latest' }))).toContain('v0.2.0');
    expect(checkResultMessage(s({ state: 'error', message: 'net' }))).toContain('net');
    expect(checkResultMessage(s({ state: 'disabled' }))).toContain('开发模式');
  });
});

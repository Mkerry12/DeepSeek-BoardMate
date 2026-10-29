// 设置面板：连接方式（官方服务器 / 自己的 API Key）、模型、人设、语音、提醒；测试连接
import type { SettingsPatch } from '../../shared/types';
import { MENU_ORDER, type Feature } from '../core/context';
import {
  API_PRESETS,
  checkConnection,
  fetchModels,
  fetchVoiceReady,
  fetchVoices,
  serverBase,
  VOICE_NEEDS_SERVER,
  VOICE_OFF,
  voiceSupported,
  type ServerVoices,
  type StatusChip,
} from '../lib/chat-api';

const minutes = (input: HTMLInputElement, fallback: number) =>
  Math.min(600, Math.max(1, Math.round(Number(input.value)) || fallback));

export const settingsPanelFeature: Feature = ({ bus, store, bubble, voice, status, menu, dom }) => {
  const {
    settingsForm: form,
    settingsStatus,
    settingsTest,
    modelSelect,
    presetSelect,
    apiModelSelect,
    voiceSelect,
    voiceHint,
  } = dom;

  status.provide('settingsOpen', () => !form.classList.contains('hidden'));

  for (const [id, { label }] of Object.entries(API_PRESETS)) presetSelect.add(new Option(label, id));
  // 音色：只有服务器 /tts/voices 的 GPT-SoVITS 预设；拿不到（API Key 模式、服务器没开语音）时下拉框灰掉
  function showVoices(list: ServerVoices | null, selected: string) {
    const voices = list?.voices || [];
    voiceSelect.disabled = !voices.length;
    if (!voices.length) return voiceSelect.replaceChildren(new Option('没有可用音色', ''));
    voiceSelect.replaceChildren(...voices.map((v) => new Option(v.label || v.id, v.id)));
    voiceSelect.value = voices.some((v) => v.id === selected) ? selected : list!.default || voices[0].id;
  }

  // 语音区：API Key 模式没填访问令牌就没有语音（朗读开关灰掉）；能用时看服务器 /health 的 gsv，没开就提示一句
  let voiceSeq = 0;
  async function refreshVoice(selected = voiceSelect.disabled ? store.settings.voice.name : voiceSelect.value) {
    const seq = ++voiceSeq;
    const conn = formSettings();
    const supported = voiceSupported(conn);
    form.voiceOn.disabled = !supported;
    voiceHint.textContent = supported ? '' : VOICE_NEEDS_SERVER;
    showVoices(null, selected);
    if (!supported) return;
    const [ready, list] = await Promise.all([
      fetchVoiceReady(conn),
      conn.token ? fetchVoices(conn) : Promise.resolve(null),
    ]);
    if (seq !== voiceSeq) return;
    voiceHint.textContent = ready === false ? VOICE_OFF : '';
    showVoices(list, selected);
  }

  function syncFormMode() {
    form.dataset.mode = form.mode.value;
    form.dataset.preset = presetSelect.value;
    const models = API_PRESETS[presetSelect.value].models || [];
    if ([...apiModelSelect.options].map((o) => o.value).join() !== models.join()) {
      apiModelSelect.replaceChildren(...models.map((m) => new Option(m, m)));
    }
  }

  function fillModelSelect(models: string[] | undefined, defaultModel: string, selected: string) {
    const options = [new Option(defaultModel ? `服务器默认（${defaultModel}）` : '服务器默认', '')];
    for (const m of models || []) if (m !== defaultModel) options.push(new Option(m, m));
    if (selected && !options.some((o) => o.value === selected)) options.push(new Option(selected, selected));
    modelSelect.replaceChildren(...options);
    modelSelect.value = selected || '';
  }

  async function loadServerModels() {
    const selected = modelSelect.value;
    try {
      const { models, default: def } = await fetchModels(formSettings());
      fillModelSelect(models, def, selected);
    } catch {}
  }

  function setSecretVisible(btn: HTMLElement, visible: boolean) {
    (btn.previousElementSibling as HTMLInputElement).type = visible ? 'text' : 'password';
    btn.classList.toggle('on', visible);
    btn.title = visible ? '隐藏' : '显示';
  }

  function setStatus(kind: string, content: string | Node | Node[] = []) {
    settingsStatus.className = `status ${kind}`.trim();
    settingsStatus.replaceChildren(...[content].flat());
  }

  function chip({ text, ok }: StatusChip) {
    const el = document.createElement('span');
    el.className = `chip ${ok ? 'ok' : 'bad'}`;
    el.textContent = `${ok ? '✓' : '✕'} ${text}`;
    return el;
  }

  function showVolume() {
    dom.volumeOut.value = `${form.volume.value}%`;
  }

  function openSettings() {
    const { settings } = store;
    form.mode.value = settings.mode;
    form.token.value = settings.token;
    form.voiceToken.value = settings.token;
    form.serverUrl.value = settings.serverUrl;
    form.serverUrl.placeholder = settings.officialServerUrl;
    form.querySelector<HTMLDetailsElement>('.adv')!.open = !!settings.serverUrl;
    presetSelect.value = API_PRESETS[settings.api.preset] ? settings.api.preset : 'deepseek';
    syncFormMode();
    form.apiKey.value = settings.api.key;
    form.apiBase.value = settings.api.baseUrl;
    form.apiModelName.value = settings.api.model;
    if ([...apiModelSelect.options].some((o) => o.value === settings.api.model))
      apiModelSelect.value = settings.api.model;
    form.persona.value = settings.persona;
    form.waterOn.checked = settings.reminders.water.on;
    form.waterMin.value = String(settings.reminders.water.minutes);
    form.restOn.checked = settings.reminders.rest.on;
    form.restMin.value = String(settings.reminders.rest.minutes);
    form.voiceOn.checked = settings.voice.on;
    form.sfxOn.checked = settings.voice.sfx;
    form.volume.value = String(settings.voice.volume);
    form.autoUpdate.checked = settings.autoUpdate;
    showVolume();
    fillModelSelect([], '', settings.model);
    for (const btn of form.querySelectorAll<HTMLElement>('.eye-toggle')) setSecretVisible(btn, false);
    setStatus('');
    form.classList.remove('hidden');
    form.querySelector('.panel-body')!.scrollTop = 0;
    if (settings.mode === 'official' && settings.token) loadServerModels();
    refreshVoice(settings.voice.name);
  }

  function closeSettings() {
    if (form.classList.contains('hidden')) return;
    form.classList.add('hidden');
    voice.setVolume(store.settings.voice.volume);
  }

  function formSettings() {
    const preset = presetSelect.value;
    const mode = form.mode.value as 'official' | 'apikey';
    return {
      mode,
      token: (mode === 'apikey' ? form.voiceToken : form.token).value.trim(),
      serverUrl: form.serverUrl.value.trim(),
      model: modelSelect.value,
      persona: form.persona.value.trim(),
      api: {
        preset,
        key: form.apiKey.value.trim(),
        baseUrl: form.apiBase.value.trim(),
        model: preset === 'custom' ? form.apiModelName.value.trim() : apiModelSelect.value,
      },
      reminders: {
        water: { on: form.waterOn.checked, minutes: minutes(form.waterMin, 45) },
        rest: { on: form.restOn.checked, minutes: minutes(form.restMin, 60) },
      },
      voice: {
        on: form.voiceOn.checked,
        sfx: form.sfxOn.checked,
        name: voiceSelect.disabled ? store.settings.voice.name : voiceSelect.value,
        volume: Number(form.volume.value),
      },
      autoUpdate: form.autoUpdate.checked,
      officialServerUrl: store.settings.officialServerUrl,
    } satisfies SettingsPatch;
  }

  form.addEventListener('change', (e) => {
    const isMode = (e.target as HTMLInputElement).name === 'mode';
    if (isMode || e.target === presetSelect) syncFormMode();
    if (isMode || e.target === form.token || e.target === form.voiceToken) refreshVoice();
  });

  // 两种模式各有一个令牌输入框，存的是同一个设置
  form.token.addEventListener('input', () => (form.voiceToken.value = form.token.value));
  form.voiceToken.addEventListener('input', () => (form.token.value = form.voiceToken.value));

  // 音量：拖动时正在播的语音立刻跟着变，松手后没在说话就响一声试听
  form.volume.addEventListener('input', () => {
    showVolume();
    voice.setVolume(Number(form.volume.value));
  });

  form.volume.addEventListener('change', () => {
    if (!voice.active) voice.chime('done', true);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const settings = await store.update(formSettings());
    bus.emit('settings:saved', { settings });
    closeSettings();
    bubble.say('设置已保存～', 3000);
  });

  dom.settingsClose.addEventListener('click', closeSettings);
  for (const btn of form.querySelectorAll<HTMLElement>('.eye-toggle')) {
    btn.addEventListener('click', () =>
      setSecretVisible(btn, (btn.previousElementSibling as HTMLInputElement).type === 'password'),
    );
  }

  settingsTest.addEventListener('click', async () => {
    const conn = formSettings();
    settingsTest.disabled = true;
    setStatus('pending', '正在测试连接…');
    try {
      const { chips, models } = await checkConnection(conn);
      setStatus('', chips.map(chip));
      if (models) fillModelSelect(models.models, models.default, modelSelect.value);
      refreshVoice();
    } catch (err) {
      const where = conn.mode === 'apikey' ? '接口' : serverBase(conn);
      setStatus('bad', `无法连接 ${where}：${(err as Error).message}`);
    } finally {
      settingsTest.disabled = false;
    }
  });

  bus.on('settings:open', (payload) => {
    openSettings();
    if (payload?.focus) form[payload.focus].focus();
  });
  bus.on('menu:action', ({ action }) => {
    if (action === 'settings') openSettings();
  });
  bus.on('ui:escape', closeSettings);

  menu.register(MENU_ORDER.settings, () => [{ label: '设置', icon: 'gear', action: openSettings }]);
};

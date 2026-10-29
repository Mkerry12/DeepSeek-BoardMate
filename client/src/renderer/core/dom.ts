// index.html 里的固定节点
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html 里缺少 #${id}`);
  return el as T;
}

export interface SettingsFormElements extends HTMLFormElement {
  mode: RadioNodeList;
  token: HTMLInputElement;
  serverUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  voiceToken: HTMLInputElement;
  apiBase: HTMLInputElement;
  apiModelName: HTMLInputElement;
  persona: HTMLTextAreaElement;
  waterOn: HTMLInputElement;
  waterMin: HTMLInputElement;
  restOn: HTMLInputElement;
  restMin: HTMLInputElement;
  voiceOn: HTMLInputElement;
  sfxOn: HTMLInputElement;
  volume: HTMLInputElement;
  autoUpdate: HTMLInputElement;
}

export function queryDom() {
  return {
    canvas: byId<HTMLCanvasElement>('stage'),
    bubble: byId<HTMLDivElement>('bubble'),
    bubbleText: byId<HTMLDivElement>('bubble-text'),
    hint: byId<HTMLDivElement>('hint'),
    menu: byId<HTMLDivElement>('menu'),
    chatForm: byId<HTMLFormElement>('chat'),
    chatInput: byId<HTMLInputElement>('chat-input'),
    chatSend: byId<HTMLButtonElement>('chat-send'),
    settingsForm: byId<SettingsFormElements>('settings'),
    settingsStatus: byId<HTMLDivElement>('settings-status'),
    settingsTest: byId<HTMLButtonElement>('settings-test'),
    settingsClose: byId<HTMLButtonElement>('settings-close'),
    modelSelect: byId<HTMLSelectElement>('set-model'),
    presetSelect: byId<HTMLSelectElement>('set-preset'),
    apiModelSelect: byId<HTMLSelectElement>('set-api-model'),
    voiceSelect: byId<HTMLSelectElement>('set-voice'),
    voiceHint: byId<HTMLSpanElement>('set-voice-hint'),
    volumeOut: byId<HTMLOutputElement>('set-volume-out'),
  };
}

export type Dom = ReturnType<typeof queryDom>;

export function showHint(dom: Pick<Dom, 'hint'>, text: string): void {
  dom.hint.textContent = text;
  dom.hint.classList.remove('hidden');
}

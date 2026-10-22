// 朗读：跟着对话流式朗读、出错 / 停止时闭嘴、菜单里的「语音朗读」开关
import { MENU_ORDER, type Feature } from '../core/context';

export const voiceFeature: Feature = ({ bus, store, pet, bubble, voice, status, menu }) => {
  status.provide('voiceActive', () => voice.active);
  pet.setLipSync(() => voice.level());

  bus.on('chat:start', () => voice.stop());
  bus.on('chat:delta', ({ text }) => voice.feed(text));
  bus.on('chat:end', ({ reply }) => {
    voice.flush();
    if (reply && !store.settings.voice.on) voice.chime('done');
  });
  bus.on('chat:error', () => {
    voice.stop();
    voice.chime('failed');
  });
  bus.on('settings:saved', ({ settings }) => {
    if (!settings.voice.on) voice.stop();
  });
  bus.on('ui:escape', () => voice.stop());

  async function toggleVoice() {
    const on = !store.settings.voice.on;
    await store.update({ voice: { ...store.settings.voice, on } });
    if (!on) {
      voice.stop();
      return bubble.say('好～那我就安安静静地说', 2500);
    }
    pet.react('happy');
    bubble.say('语音打开啦！我会把回复读给你听～', 3500);
    voice.speak('语音打开啦！我会把回复读给你听～');
  }

  menu.register(MENU_ORDER.voice, () => [
    { label: '语音朗读', icon: 'voice', checked: store.settings.voice.on, action: toggleVoice },
  ]);
};

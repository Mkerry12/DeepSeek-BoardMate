// 自动更新的提示：下载好了 / 便携版有新版本时气泡说一声；右键菜单「检查更新」/「重启并更新」/「下载新版本」
import { checkResultMessage, updateAnnouncement, updateMenuItem, type UpdateStatus } from '../../shared/update';
import { MENU_ORDER, type Feature } from '../core/context';

const RETRY_WHEN_BUSY = 30000;

export const updaterFeature: Feature = ({ bus, bubble, pet, status, menu }) => {
  let current: UpdateStatus | null = null;

  function announce(text: string) {
    if (status.busy() || status.get('voiceActive')) {
      setTimeout(() => announce(text), RETRY_WHEN_BUSY);
      return;
    }
    pet.react('happy');
    bubble.say(text, 8000);
  }

  function apply(next: UpdateStatus) {
    const text = updateAnnouncement(current, next);
    current = next;
    if (text) announce(text);
  }

  window.desk.onUpdateStatus(apply);
  bus.on('app:ready', async () => apply(await window.desk.getUpdateStatus()));

  async function act(action: ReturnType<typeof updateMenuItem>['action']) {
    if (action === 'install') return window.desk.installUpdate();
    if (action === 'open-page') return window.desk.openReleasePage();
    bubble.say('我去看看有没有新版本…', 3000);
    const result = await window.desk.checkUpdate();
    current = result;
    bubble.say(checkResultMessage(result), 5000);
    if (result.state === 'available') window.desk.openReleasePage();
  }

  menu.register(MENU_ORDER.update, async () => {
    const s = current ?? (await window.desk.getUpdateStatus());
    if (s.state === 'disabled') return [];
    const item = updateMenuItem(s);
    return [{ label: item.label, icon: 'download', hint: item.hint, action: () => act(item.action) }];
  });
};

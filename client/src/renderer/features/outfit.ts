// 换装：右键菜单里按 pet.json 的槽位换眼镜、发饰、桌布……（哪些槽位出现在菜单里由角色配置决定）
import type { Outfit } from '../../shared/types';
import { MENU_ORDER, type Feature } from '../core/context';
import type { MenuEntry } from '../services/menu';

export const outfitFeature: Feature = ({ store, pet, menu, character }) => {
  const { slots: slotIds, slotLabels, optionLabels } = character.outfit;

  function outfitSlots() {
    return pet.slots
      .filter((slot) => slotIds.includes(slot.id))
      .map((slot) => ({
        ...slot,
        options: slot.options.filter((o) => o.expressions?.length && !o.motion && !o.clears),
      }))
      .filter((slot) => slot.options.length);
  }

  async function applyOutfit(outfit: Outfit) {
    const settings = await store.update({ outfit });
    pet.setOutfit(settings.outfit);
    pet.react('happy');
  }

  function outfitItems(): MenuEntry[] {
    const slots = outfitSlots().map((slot): MenuEntry => {
      const names = optionLabels[slot.id] || {};
      const current = store.settings.outfit[slot.id] || '';
      const option = (label: string, value: string): MenuEntry => ({
        label,
        checked: (store.settings.outfit[slot.id] || '') === value,
        stay: true,
        action: () => applyOutfit({ ...store.settings.outfit, [slot.id]: value }),
      });
      return {
        label: slotLabels[slot.id] || slot.label,
        hint: current ? names[current] || current : names.none || slot.none,
        submenu: () => [
          option(names.none || slot.none, ''),
          ...slot.options.map((o) => option(names[o.label] || o.label, o.label)),
        ],
      };
    });
    return [
      ...slots,
      '-',
      {
        label: '恢复默认',
        icon: 'refresh',
        stay: true,
        action: () => applyOutfit({ ...character.outfit.default }),
      },
    ];
  }

  menu.register(MENU_ORDER.outfit, () => [{ label: '换装', icon: 'shirt', submenu: outfitItems }]);
};

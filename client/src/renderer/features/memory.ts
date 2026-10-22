// 「她记得的事」：查看 / 立即整理 / 忘掉长期记忆；每轮对话结束后计数，攒够了后台自动整理
import { MENU_ORDER, type Feature } from '../core/context';

export const memoryFeature: Feature = ({ bus, store, pet, bubble, memory, status, menu, character }) => {
  const say = bubble.say;
  const eraser = character.live2d.props.eraser?.look;

  bus.on('chat:end', ({ reply }) => {
    if (reply) memory.added(2);
  });

  function showMemory() {
    if (!memory.text) return say('小本本上还没记什么呢～多和我聊聊吧！', 4000);
    pet.react('proud');
    say(`小本本上记着：\n${memory.text}`, 15000);
  }

  async function organizeMemory() {
    if (!store.history.length) return say('我们还没聊过天呢，没什么好整理的～', 3000);
    pet.setNotes(true);
    bubble.sayTyping('小鲸在整理小本本');
    try {
      await memory.summarize();
      if (eraser) pet.flash(eraser);
      showMemory();
    } catch (err) {
      pet.react('soulout');
      say(`整理失败了：${(err as Error).message}`, 5000);
    } finally {
      if (!status.get('replying')) pet.setNotes(false);
    }
  }

  function forgetMemory() {
    memory.clear();
    if (eraser) pet.flash(eraser);
    pet.react('confused');
    say('咦…我刚刚记得什么来着？全忘光啦～', 4000);
  }

  menu.register(MENU_ORDER.memory, () => [
    {
      label: '她记得的事',
      icon: 'book',
      submenu: () => [
        { note: memory.busy ? '正在整理…' : '小鲸会悄悄记下关于你的事' },
        { label: '她记得的事', icon: 'book', action: showMemory },
        { label: '现在整理一下', icon: 'refresh', action: organizeMemory },
        { label: '忘掉这些', icon: 'trash', confirm: '再点一次，确认忘掉', action: forgetMemory },
      ],
    },
  ]);
};

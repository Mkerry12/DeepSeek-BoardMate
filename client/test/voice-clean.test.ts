import { describe, expect, it } from 'vitest';
import { cleanForSpeech } from '../src/renderer/services/voice';

describe('cleanForSpeech', () => {
  it('strips emotion tags, markdown and emoji', () => {
    expect(cleanForSpeech('[happy]**你好**呀😀，看 https://x.y')).toBe('你好 呀，看');
  });

  it.each([
    ['好耶(｡•̀ᴗ-)✧', '好耶'],
    ['气死了(╯°□°）╯︵ ┻━┻', '气死了'],
    ['开心(≧▽≦)', '开心'],
    ['嗯(´・ω・`)', '嗯'],
    ['哇o(*￣▽￣*)o好棒', '哇好棒'],
    ['耶\\(^o^)/', '耶'],
    ['呜呜QwQ', '呜呜'],
    ['哈哈^_^', '哈哈'],
    ['好难T_T', '好难'],
    ['啊>_<', '啊'],
    ['(T_T)不要', '不要'],
    ['好的:)', '好的'],
    ['太好了:D', '太好了'],
    ['owo是什么', '是什么'],
    ['晚安★☆♡❤✿♪✧', '晚安'],
  ])('strips kaomoji / emoticons: %s', (input, expected) => {
    expect(cleanForSpeech(input)).toBe(expected);
  });

  it.each(['（比如这样）', '第(1)步', '用(TTS)朗读', '10:30 开会', 'QwQa 不算', '好的～'])(
    'keeps normal text: %s',
    (text) => {
      expect(cleanForSpeech(text)).toBe(text);
    },
  );
});

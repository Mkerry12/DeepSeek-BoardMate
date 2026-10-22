import emotionTags from '../../../shared/emotion-tags.json';

/** 模型回复开头允许的情绪标签，与服务器提示词共用 shared/emotion-tags.json */
export const EMOTION_TAGS: readonly string[] = emotionTags.tags;

/** 不对应表情、由桌宠自己处理的标签：thinking 切换思考姿势，neutral 清掉情绪层 */
export const STATE_TAGS: readonly string[] = ['thinking', 'neutral'];

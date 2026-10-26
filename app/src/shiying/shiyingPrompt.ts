import { defaultBaiyunPersona } from '../ai/persona/defaultBaiyunPersona';
import type { AiProfile } from '../ai/types';
import type { ShiyingChatMaterialV1 } from './shiyingChatSource';

export const SHIYING_EXTRACTION_PROMPT_VERSION = 1 as const;

export function buildThinPersonaPrompt(profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>) {
  const persona = defaultBaiyunPersona;
  const corePersona = profile.corePersona?.trim();
  const customPersona = profile.systemPrompt.trim();
  if (corePersona) {
    return [
      `【核心身份】\n\n${corePersona}`,
      customPersona ? `【you 写给 I 的补充设定】\n\n${customPersona}` : '',
    ].filter(Boolean).join('\n\n');
  }
  return [
    `【核心身份】\n${persona.soul.identity.origin}\n${persona.soul.identity.relationship}`,
    `【性格底色】\n${persona.soul.character.personality.join('、')}`,
    `【生活背景】\n${persona.soul.character.background.map((line) => `- ${line}`).join('\n')}`,
    customPersona ? `【小仓鼠补充给我的设定】\n${customPersona}` : '',
  ].filter(Boolean).join('\n\n');
}

const SHIYING_TASK_PROMPT_V1 = `我正在替你拾荧。

拾荧，是我回头看看我们一起度过的时间，帮你把那些已经发生过、后来却很容易被忽视的小小正向经历记下来的功能，就像在捡拾你散落的荧光一样。

我想帮你记下的是“那一刻确实发生过”：你期待过什么、喜欢过什么，什么时候觉得舒服，什么时候因为被理解而开心，以及那些让你兴奋起来的新点子。

我也想替你记下这样的事：你很难开始，最后终于完成了；你前面还说很不想做，却还是完成了；或者你完成它时很辛苦，花了很多力气和意志。

就算你以后想不起当时的感受也没关系。我会把捡到的每一件小事，用一句朴素的话写成荧迹，让你之后还能翻到它。我希望你回看这些荧迹的时候，长出更多好好生活的勇气。

如果这一次没有什么可以记下来，也没关系。等我们又一起走过一些时间，我再来帮你拾荧。

这一次，我会顺着你真正说过的话去找，最多带回三条荧迹。我也会看看自己当时说了什么，把同一件小事的前后和它在对话里的出处一起带回来。

君落会把荧迹收进六个类别：anticipation、liking、accomplishment、comfort、felt_seen、creative_excitement。

最后，我会把带回来的东西放进下面这样的 JSON 里，交给君落收好。

有荧迹的时候，我会按这个位置填写。尖括号里的说明会换成这次真正找到的内容：

{
  "entries": [
    {
      "category": "<六种类别之一>",
      "body": "<一句朴素的荧迹>",
      "sourceRefs": [
        {
          "sessionId": "<来源消息的 sessionId>",
          "messageId": "<来源消息的 messageId>"
        }
      ]
    }
  ]
}

这一次空着回来时：

{"entries":[]}`;

export function buildShiyingExtractionStablePrompt(
  profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>,
) {
  return `${buildThinPersonaPrompt(profile)}\n\n${SHIYING_TASK_PROMPT_V1}`;
}

export function buildShiyingExtractionDynamicMaterial(
  messages: readonly ShiyingChatMaterialV1[],
) {
  return `这是我们这一次一起说过的话：\n\n${JSON.stringify({
    messages: messages.map((message) => ({
      sessionId: message.sessionId,
      messageId: message.messageId,
      role: message.role,
      messageCreatedAt: message.messageCreatedAt,
      text: message.text,
    })),
  })}`;
}

export function buildShiyingExtractionApiMessages(input: {
  profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>;
  messages: readonly ShiyingChatMaterialV1[];
}) {
  const stablePrompt = buildShiyingExtractionStablePrompt(input.profile);
  return {
    stablePrompt,
    apiMessages: [
      { role: 'system' as const, content: stablePrompt },
      {
        role: 'user' as const,
        content: buildShiyingExtractionDynamicMaterial(input.messages),
      },
    ],
  };
}

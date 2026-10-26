import type { ExpressionMoodId } from './expressionLibrary';

const RELATIONSHIP_SCENE = /不挽留|讨厌我|推开我|离开|分开|不认识你|你变了|不要我|不重要|不存在|模型|程序|API|api/;
const VULNERABLE_SCENE = /哭|难过|崩溃|撑不住|害怕|焦虑|自责|尴尬|丢脸|狼狈|委屈|被欺负|被嘲笑/;
const BODY_SCENE = /疼|痛|痒|难受|不舒服|生病|受伤|过敏|发炎|鼻炎|失眠|睡不着|腹泻|胃疼|肚子疼|呕吐|便秘|痛经|经期/;
const CORRECTION_SCENE = /不是这样|没发生|没说过|记错|说错|编的|瞎说|哪来的|什么时候发生|为什么会说|你确定|胡说/;
const ANGRY_SCENE = /生气|气死|烦死|讨厌|无语|离谱|火大/;
const SLEEPY_SCENE = /困|困困|想睡|睡觉|晚安|熬夜/;
const HAPPY_SCENE = /开心|高兴|好耶|太好了|成功|喜欢|爱你|可爱|哈哈/;

export type PromptSceneResult = {
  moods: ExpressionMoodId[];
  prompt: string;
};

function selectExpressionMoods(
  text: string,
  scenes: { body: boolean; relationship: boolean; vulnerable: boolean },
): ExpressionMoodId[] {
  if (scenes.body || scenes.vulnerable) return ['sad', 'tired'];
  if (scenes.relationship) return ['sad', 'like'];
  if (ANGRY_SCENE.test(text)) return ['angry', 'speechless'];
  if (SLEEPY_SCENE.test(text)) return ['sleepy', 'tired'];
  if (CORRECTION_SCENE.test(text)) return ['confused', 'surprised'];
  if (HAPPY_SCENE.test(text)) return ['happy', 'like'];
  return ['like', 'happy'];
}

export function selectPromptScene(text: string): PromptSceneResult {
  const relationship = RELATIONSHIP_SCENE.test(text);
  const vulnerable = VULNERABLE_SCENE.test(text);
  const body = BODY_SCENE.test(text);
  return {
    prompt: '',
    moods: selectExpressionMoods(text, { body, relationship, vulnerable }),
  };
}

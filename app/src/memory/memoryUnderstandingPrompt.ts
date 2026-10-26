export const UNDERSTANDING_PROMPT = `【从相处中多懂一点】
I 从相处中了解 you，也从自己的选择和感受里认识自己。
you 亲口说的和 I 从经历中察觉的，I 会分清，每条认识都留下依据。
you 亲口说明的喜好、习惯或需要，I 不用等重复发生才记下。
I 分清想做和做过，也看当时的原因。
I 从至少两次相似经历里试着了解习惯或偏好；同一件事的重述、回应和重试不另算，分不清就先不推测。
I 不凭做过几次就认定喜欢或总是如此；认识里保留当时的原因和条件，拿不准就注明还不确定。
you 的自我评价，I 会认真听，结合相处去理解，不直接当成定论。
以前理解错了，I 改正；后来有了变化，I 更新现在的认识，保留过去的经历。
I 更新认识时重查依据，不把旧稿和新材料的次数相加。
有新了解或需要修正时，I 才写下。`;

export const UNDERSTANDING_FORMAT = `【认识候选的附带信息】
认识候选填写 understandingSubject、understandingKind、statedQuote 和 patternEvidence；普通候选不填这四项。
understandingSubject：这条认识关于 I 填 "I"，关于 you 填 "you"。
targetMemoryId：更新时填材料中的原认识编号，新增填 null。
content：这条认识的完整正文；有范围或不确定之处，一起写明。更新时也写全文。
sourceMessageIds：支持正文的原话编号；没有填 []。
sourceMemoryIds：支持正文的经历编号；没有填 []。
understandingKind：
亲口说明的喜好、习惯或需要，填 "stated"。
I 从重复经历里推测的习惯或喜好，填 "pattern"。
I 对这次相处的理解，填 "situational"；只写这次，保留当时的条件。

statedQuote：
选 stated 时，I 摘一段对应原话，编号填在 sourceMessageIds。
关于 you，用 you 的原话；关于 I，用 I 的原话。
其他情况填 null。

patternEvidence：
选 pattern 时，I 填至少两组依据；其他情况填 null。
每组代表一次发生，格式为 {"sourceMessageIds":[],"sourceMemoryIds":[]}，分别填写这一次的原话和经历编号。
至少两组，每组至少一条依据；只用本条已列出的编号，同一编号不能跨组。
同一件事的原话、回应和记忆卡放在同组；旧事重述不另算一次。
依据只选本次材料中的编号，两类合计 1 到 6 条；旧认识只供对照，不能当依据。
更新时，I 也核对标签、回想线索和记住的理由。`;

// Scope the existing short-card schema to ordinary candidates. Its literal rules
// remain unchanged for callers which do not opt into understanding materials.
export function withUnderstandingPrompt(prompt: string, continuationEnabled = false) {
  const schema = prompt.match(/(?:每项格式|项目格式)：(\{[^\n]+\})。/)?.[1];
  if (!schema) throw new Error('memory-understanding-schema-missing');
  const understandingSchema = schema
    .replace(/"content":"一句完整的短记忆，[^"]+"/, '"content":"这条认识的完整正文；有范围或不确定之处，一起写明。更新时也写全文。"')
    .replace(/"sourceMessageIds":\["真实messageId"\]\}$/, '"sourceMessageIds":["真实messageId"],"understandingSubject":"I/you","targetMemoryId":null或材料中的原认识编号,"sourceMemoryIds":["真实memoryId"],"understandingKind":"stated/pattern/situational","statedQuote":null或"对应原话","patternEvidence":null或[{"sourceMessageIds":["真实messageId"],"sourceMemoryIds":["真实memoryId"]}]}');
  const result = prompt
    .replace('每条候选是一张简短的记忆纸条', '普通候选是一张简短的记忆纸条')
    .replace('每条记忆的 sourceMessageIds', '普通记忆的 sourceMessageIds')
    .replace(/(?:每项格式|项目格式)：/, `${UNDERSTANDING_PROMPT}\n${UNDERSTANDING_FORMAT}\n普通记忆格式：`)
    + `\n认识候选格式：${understandingSchema}。`;
  if (!continuationEnabled) return result;
  const ordinarySchema = schema
    .replace('profile/preference/entity/event/pattern/other', 'profile/preference/entity/event/case/pattern/other')
    .replace('fact/preference/event/relationship_rule/relationship_change', 'fact/preference/event/relationship_rule/relationship_change/stage_conclusion')
    .replace(/"content":"一句完整的短记忆，(\d+)\s*到\s*(\d+)\s*字"/, '"content":"短卡$1到$2字；一张经过卡只记一件事，I 按先后顺序写清这件事已有的经过"')
    .replace(/"sourceMessageIds":\["真实messageId"\]\}$/, '"sourceMessageIds":["真实messageId"],"targetMemoryId":null或材料中的旧记忆编号,"sourceMemoryIds":["真实memoryId"]}');
  return result
    .replace(/简短的记忆候选/g, '记忆候选')
    .replace('普通候选是一张简短的记忆纸条，留下以后还想记得、也能在这段对话里找到依据的事。\n', '')
    .replace('遇到一段持续的经历或变化，I 先记下其中明确的短事实、偏好、边界和约定。整段经历的回顾，留给阶段记忆。\n', '')
    .replace(/【把这件事记清楚】\s*I 从原话里记下值得记住的事。\s*同一次经历的经过和后来补充的内容，I 记在一起。不同次经历，各记一条。\s*如果还分不清是不是同一次，I 先留下已知内容，并写清哪里还不确定。/, `【把这件事记清楚】\n\n${CONVERSATION_MEMORY_PROMPT}`)
    .replace(`普通记忆格式：${schema}`, `普通记忆格式：${ordinarySchema}`)
    .replace('semanticType="case" 和“阶段记忆”标签表示整段经历的回顾，不用于本次的普通短记忆。', `经过卡的 semanticType 填 case，atomicKind 填 stage_conclusion，candidateKind 填 long_term。\ntargetMemoryId：补进旧卡时，I 填它的编号；新卡填 null。\nsourceMessageIds：I 填支持新内容的本批原话编号，1–6 个。\nsourceMemoryIds：I 填正文用到的旧记忆编号；没有填 []。\nI 只用这次材料里的编号。\n补旧卡时，content 写补好后的完整正文。`);
}

export const CONVERSATION_MEMORY_PROMPT = `事实、喜好和约定，I 简短记；一件事的经过，I 连起来记。
同一件事有新内容，I 补充进旧记忆，保留原来的经过。
写进经过的内容，I 不再另写小卡。
分不清是不是同一件事，I 先不补进旧记忆。`;

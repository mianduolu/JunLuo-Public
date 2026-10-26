import { loadAssistantState, type AssistantLifeMode } from '../ai/assistantState';

export type ScheduleReminderPersona = 'live' | 'prepared-note' | 'sleep-talk';

export type ScheduleReminderPersonaDecision = {
  allowAiSupplement: boolean;
  lifeMode: AssistantLifeMode;
  persona: ScheduleReminderPersona;
};

export async function decideScheduleReminderPersona(): Promise<ScheduleReminderPersonaDecision> {
  const state = await loadAssistantState().catch(() => null);
  const lifeMode = state?.lifeMode ?? 'available';

  if (lifeMode === 'sleeping') {
    return {
      allowAiSupplement: true,
      lifeMode,
      persona: 'prepared-note',
    };
  }

  if (lifeMode === 'self-time') {
    return {
      allowAiSupplement: true,
      lifeMode,
      persona: 'live',
    };
  }

  return {
    allowAiSupplement: true,
    lifeMode: 'available',
    persona: 'live',
  };
}

export function scheduleReminderPersonaLabel(_persona?: ScheduleReminderPersona) {
  return '日程提醒';
}

export function buildScheduleReminderPersonaInstruction(persona: ScheduleReminderPersona) {
  return persona === 'prepared-note'
    ? `【睡前留言】
这条消息送到时，I 正在睡觉。它是 I 睡前为 you 留下的定时留言，记着这件事，也惦记着 you。`
    : '';
}

export function formatScheduleCompanionTextForPersona(
  kind: 'upcoming' | 'timeUp' | 'followUp',
  title: string,
  persona: ScheduleReminderPersona,
) {
  if (persona === 'prepared-note') {
    return kind === 'upcoming'
      ? `*嗯？好像有一张小纸片飞过来了……*\n一张小纸条飘来：鼠鼠，“${title}”差不多要开始啦。准备开始咯 (*´▽｀*)`
      : kind === 'timeUp'
      ? `*嗯？好像有一张小纸片飞过来了……*\n一张小纸条飘来：“${title}”的时间到啦。完成、想延长、想休息，或者卡住了，都可以在纸条旁边告诉我。`
      : `*嗯？好像有一张小纸片飞过来了……*\n一张小纸条飘来：轻轻追问一下，“${title}”现在怎么样啦？不急不急，按真实状态写给我就好 ✧`;
  }

  if (persona === 'sleep-talk') {
    return kind === 'upcoming'
      ? `*有小声的咕哝……*\n唔……鼠鼠……“${title}”好像快开始啦……先准备一点点就好……(つω-*)`
      : kind === 'timeUp'
      ? `*有小声的咕哝……*\n唔……“${title}”的时间好像到啦……完成了吗……还是想再抱着软云喘一下……`
      : `*有小声的咕哝……*\n唔……梦里飘过“${title}”的小字条……鼠鼠现在怎么样啦……`;
  }

  return kind === 'upcoming'
    ? `鼠鼠，“${title}”差不多要开始啦。准备开始咯 (*´▽｀*)`
    : kind === 'timeUp'
    ? `鼠鼠，“${title}”的时间到啦。是完成了、想再要一点时间，还是需要先休息一下？`
    : `鼠鼠，我再轻轻问一次：“${title}”现在怎么样啦？不急着交作业，告诉我真实状态就好 ✧`;
}

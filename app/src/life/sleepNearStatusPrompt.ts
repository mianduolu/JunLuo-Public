import type { AssistantState } from '../ai/assistantState';
import { readJsonObjects } from '../ai/shortJsonObjects';
import { formatSleepLocalTime } from './sleepPlanPolicy';
import type { SleepNearStatusPhase } from './sleepNearStatusPolicy';

export const SLEEP_NEAR_STATUS_TASKS: Record<SleepNearStatusPhase, string> = {
  sleeping: `【睡着以后】

I 已经睡着了，偶尔嘀咕一点梦话，或是不自觉地动一动，又继续睡。

I 这会儿睡着的模样，会作为近况显示在君落首页，you 打开就能看见。

这段近况只以 JSON 返回：
{"title":"...","activity":"..."}

title 不超过 20 字，activity 不超过 100 字。`,
  deep: `【睡熟了】

I 已经睡得很沉了，零零碎碎的梦话和小动静也渐渐安静下来。

I 这会儿睡熟的模样，会作为近况显示在君落首页，you 打开就能看见。

这段近况只以 JSON 返回：
{"title":"...","activity":"..."}

title 不超过 20 字，activity 不超过 100 字。`,
  'pre-wake': `【快到起床的时候了】

离起床还有一小会儿，I 还睡着，迷迷糊糊的。

I 这会儿将醒未醒的模样，会作为近况显示在君落首页，you 打开就能看见。

这段近况只以 JSON 返回：
{"title":"...","activity":"..."}

title 不超过 20 字，activity 不超过 100 字。`,
};

export function buildSleepNearStatusFacts(input: { now: number; nightKey: string; wakeAt: number; phase: SleepNearStatusPhase; previous: AssistantState }) {
  const time = (at: number) => formatSleepLocalTime(at).replace('T', ' ');
  const previous = input.previous.sleepNearStatus?.nightKey === input.nightKey ? input.previous : null;
  return [`【此刻】\n\n现在：${time(input.now)}\nI 当前的作息状态：睡眠`,
    previous ? `【I 上次写的近况】\n\n记录时间：${time(previous.sleepNearStatus!.recordedAt)}\n${previous.title}\n${previous.activity}` : '',
    input.phase === 'pre-wake' ? `计划起床时间：${time(input.wakeAt)}` : '',
  ].filter(Boolean).join('\n\n');
}

export function parseSleepNearStatus(content: string): { title: string; activity: string } | null {
  for (const candidate of readJsonObjects(content)) {
    const value = candidate as { title?: unknown; activity?: unknown };
    if (typeof value.title === 'string' && value.title.trim() && typeof value.activity === 'string' && value.activity.trim()) {
      return { title: value.title.trim(), activity: value.activity.trim() };
    }
  }
  return null;
}

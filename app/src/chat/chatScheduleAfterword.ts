export type ScheduleAfterwordKind =
  | 'plan-confirmed'
  | 'change-confirmed';

export type ScheduleAfterwordPlan = {
  scheduled: {
    slots: readonly unknown[];
  };
};

export type ScheduleAfterwordChange = {
  after?: string;
  kind: string;
  title: string;
};

export type ScheduleAfterwordTarget =
  | ScheduleAfterwordPlan
  | ScheduleAfterwordChange;

export function buildScheduleAfterwordFallback(
  kind: ScheduleAfterwordKind,
  target: ScheduleAfterwordTarget,
) {
  if (kind === 'plan-confirmed') {
    const plan = target as ScheduleAfterwordPlan;
    const blockText = plan.scheduled.slots.length
      ? `${plan.scheduled.slots.length} 个时间块`
      : '找时间做的小事';
    return [
      `好，${blockText}已经放进日程啦。♪(´▽\`ʃ♡ƪ)`,
    ];
  }

  const card = target as ScheduleAfterwordChange;
  if (card.kind.startsWith('delete')) {
    return [
      `“${card.title}”已经撤掉啦。 (oﾟvﾟ)ノ`,
    ];
  }
  const after = card.after?.trim();
  if (!after) return [];
  return [
    `好，“${card.title}”已经挪到 ${after} 啦。它现在待在新的时间里了( •̀ ω •́ )✧`,
  ];
}

export const LEGACY_SCHEDULE_SYSTEM_PROMPT = `只处理明确安排请求，输出待确认JSON。现实行动进日程/待办；评价AI、讨论规则、排查误触、要求改说话返回空。修bug/调prompt/测试若是小仓鼠要做的事，可安排。具体时刻进日程；无时刻但明确要记/提醒/以后做进待办。最多5项，仅未来，避开占用，不编造。`;

export const LEGACY_SCHEDULE_FORMAT_HINT = `JSON:{schedules:[{title,startAt,endAt}],todos:[{title,plannedForDate,priority,quadrant,category,estimatedMinutes}],intentConfidence,reason};时间用ISO。`;

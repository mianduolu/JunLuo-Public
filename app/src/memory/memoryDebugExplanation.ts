import type { MemoryBundleDebug } from './memoryOrchestrator';
import type { MemoryRecallItem } from './memoryStore';
import { getMemorySpeechPolicy } from './memorySpeechPolicy';
import type { MemoryRecallWorkPhase } from './memoryChatPreparation';

export type MemoryDebugExplanation = {
  actions: string[];
  dropNotes: string[];
  headline: string;
  itemCountLabel: string;
  tags: string[];
};

export function describeMemoryProvision(debug: MemoryBundleDebug | null | undefined) {
  const count = debug?.sentCount ?? 0;
  const status = debug?.preparation?.status;
  const unfinished = status === 'failed' || status === 'timeout';
  if (count > 0) return `本轮提供 ${count} 条记忆${unfinished ? '\n记忆查找未完成' : ''}`;
  if (unfinished) return '记忆查找未完成';
  return status === 'ready' ? '没有相关记忆' : '本轮未查找';
}

function preparationNotes(debug: MemoryBundleDebug) {
  if (!debug.preparation) return [];
  const labels: Record<string, string> = {
    empty_query: '没有查找内容', configuration_missing: '配置缺失', cancelled: '已取消',
    timeout: '等待超时', http_error: '服务请求失败', parse_error: '返回内容解析失败',
    network_error: '网络连接失败', index_unavailable: '当前向量索引不可用',
    configuration_changed: '配置已变化', read_failed: '读取失败',
    database_busy: '数据库正忙或被锁住', response_payload_invalid: '服务返回结构不符合接口格式',
    response_empty: '模型没有返回正文', response_reasoning_only: '模型只返回推理内容，没有正文',
    response_truncated: '返回内容达到输出上限，未得到完整判断', route_json_missing: '模型正文中没有完整判断 JSON',
    route_json_invalid: '判断 JSON 格式错误', route_shape_invalid: '判断字段不符合约定',
    post_database_busy: '附带动态读取遇到数据库繁忙', post_read_failed: '附带动态读取失败',
    focus_database_busy: '专注补充资料读取遇到数据库繁忙', focus_read_failed: '专注补充资料读取失败',
    shiying_source_unavailable: '拾荧来源不可用', shiying_read_failed: '拾荧资料读取失败',
    deadline_exceeded: '本轮查找时间已用完', background_only: '本轮仅准备背景记忆', route_unavailable: '回想判断未完成',
    route_fallback: '判断未完成，已按当前聊天查找',
  };
  const statuses = { ready: '完成', not_started: '未启动', failed: '失败', timeout: '超时', cancelled: '已取消' };
  const workLabels: Record<MemoryRecallWorkPhase, string> = { candidate_read: '候选读取', basis_check: '依据核对',
    source_read: '来源读取', vector_search: '向量查找', embedding_http: '嵌入HTTP等待（fetch交回前）',
    embedding_parse: '嵌入响应JSON读取／解析', vector_match: '本地向量匹配（含读索引）',
      vector_match_memory: '正式记忆匹配', vector_match_current_state: '近况匹配',
      vector_match_shiying: '拾荧匹配', vector_match_post: '动态匹配',
    database_queue: '数据库排队', database_read: '数据库实际读取' };
  return ([['回想判断', debug.preparation.route], ['本地查找', debug.preparation.local],
    ['深入查找', debug.preparation.semantic]] as const).flatMap(([label, stage]) => {
      const details = Object.entries(workLabels).flatMap(([phase, title]) => {
        const measurement = stage.work?.[phase as MemoryRecallWorkPhase];
        return measurement ? [`${title} ${Math.round(measurement.elapsedMs)} 毫秒 / ${measurement.count} 次${measurement.httpStatus !== undefined ? `，最后HTTP ${measurement.httpStatus}` : ''}${measurement.active ? `，结束时仍有 ${measurement.active} 项未完成` : ''}`] : [];
      });
      return [`${label}：${statuses[stage.status]}${stage.reason ? `（${labels[stage.reason] ?? '未记录具体原因'}）` : ''}`,
        ...(details.length ? [`${label}细分（含嵌套等待，不相加）：${details.join('；')}`] : [])];
    });
}

export function buildMemoryDebugExplanation(
  debug: MemoryBundleDebug | null | undefined,
  items: MemoryRecallItem[] | null | undefined,
): MemoryDebugExplanation {
  if (!debug) {
    return {
      actions: ['这一轮还没有调试报告。'],
      dropNotes: [],
      headline: items?.length ? '白云想起了一些记忆，但这一轮没有留下总控说明。' : '这一轮没有找到能带进对话的记忆。',
      itemCountLabel: `${items?.length ?? 0} 条记忆`,
      tags: [],
    };
  }

  const counts = debug.counts ?? {};
  const recall = counts.recall ?? 0;
  const background = counts.quietContext ?? counts.quiet_context ?? 0;
  const carePool = counts.carePool ?? 0;
  const spoken = counts.spokenMention ?? counts.suggestedMention ?? 0;
  const held = counts.heldCare ?? Math.max(0, carePool - spoken);
  const anchors = counts.anchors ?? 0;
  const reflections = counts.reflections ?? 0;
  const nearbyPois = counts.nearbyWorldPois ?? 0;
  const sourceTraceMatched = counts.sourceTraceMatched ?? 0;

  return {
    actions: [...preparationNotes(debug), ...buildActionHints(debug, { background, carePool, held, recall, sourceTraceMatched, spoken })],
    dropNotes: buildDropNotes(debug),
    headline: debug.preparation ? describeMemoryProvision(debug) : buildHeadline(debug, { background, carePool, recall, spoken }),
    itemCountLabel: debug.preparation ? `实际提供 ${debug.sentCount ?? 0} 条记忆` : `${items?.length ?? 0} 条被白云想起的记忆`,
    tags: [
      routeLabel(debug),
      careLabel(debug),
      recall ? `${getMemorySpeechPolicy('related').debugLabel}：相关记忆 ${recall}` : '',
      spoken ? `${getMemorySpeechPolicy('spoken').debugLabel}：主动递出 ${spoken}` : '',
      background ? `${getMemorySpeechPolicy('background').debugLabel}：背景记忆 ${background}` : '',
      carePool ? `${getMemorySpeechPolicy('carePool').debugLabel}：惦记池 ${carePool}` : '',
      held ? `暂时没说 ${held}` : '',
      anchors ? `${getMemorySpeechPolicy('anchor').debugLabel}：长期坐标 ${anchors}` : '',
      reflections ? `${getMemorySpeechPolicy('reflection').debugLabel}：白云动态 ${reflections}` : '',
      sourceTraceMatched ? `${getMemorySpeechPolicy('sourceTrace').debugLabel}：原文 ${sourceTraceMatched}` : '',
      counts.nearbyWorld ? `附近地点 ${nearbyPois}` : '',
      counts.nearbyWorldWalking ? '附近世界：一起走' : '',
      counts.nearbyWorldTransit ? '附近世界：交通工具上' : '',
      counts.nearbyWorldGpsExcellent ? '定位质量：很好' : '',
      counts.nearbyWorldGpsGood ? '定位质量：不错' : '',
      counts.nearbyWorldGpsFair ? '定位质量：有些不稳' : '',
      counts.nearbyWorldGpsPoor ? '定位质量：不太可靠' : '',
      counts.nearbyWorldBackgroundPrecision ? '后台状态：后台努力' : '',
      counts.nearbyWorldNoKey ? '附近世界缺高德 Key' : '',
    ].filter(Boolean),
  };
}

export function buildMemoryRecallItemExplanation(item: MemoryRecallItem) {
  const reasons = item.recallReasons ?? [];
  const notes: string[] = [];
  if (item.reason === 'suggested_mention') {
    notes.push('这条被挑作本轮可以自然说出口的小关心。');
  } else if (item.reason === 'quiet_context') {
    notes.push('这条默认放在心里，帮白云调整语气和避雷。');
  } else if (item.reason === 'related') {
    notes.push('这条是通过关系线被带出来的关联记忆。');
  } else if (item.reason === 'semantic') {
    notes.push('这条和当前话题意思接近。');
  } else if (item.reason === 'direct' || item.reason === 'text') {
    notes.push('这条和当前文字直接对上了。');
  } else if (item.reason === 'anchor') {
    notes.push('这条是长期坐标，用来托住称呼、边界或偏好。');
  }

  if (reasons.includes('keyword_match')) notes.push('关键词命中。');
  if (reasons.includes('vector_match')) notes.push('语义相近。');
  if (reasons.includes('related_edge')) notes.push('有关系边牵到这里。');
  if (reasons.includes('high_arousal')) notes.push('情绪浓度高。');
  if (reasons.includes('stale_but_important')) notes.push('很久没想起，但仍然重要。');
  if (reasons.includes('anchor_coordinate')) notes.push('属于长期坐标。');
  if (reasons.includes('quality_confirmed')) notes.push('最近被确认过。');
  if (reasons.includes('quality_corrected')) notes.push('曾被纠正，所以会更谨慎。');
  if (reasons.includes('quality_outdated')) notes.push('更适合作为历史背景。');

  return notes.slice(0, 3).join(' ');
}

function buildHeadline(
  debug: MemoryBundleDebug,
  counts: { background: number; carePool: number; recall: number; spoken: number },
) {
  const route = debug.route;
  if (route?.mode === 'detail_recall') {
    return '本轮查找相关记忆，并尝试核对原话细节。';
  }
  if (route?.mode === 'recall') {
    return '本轮根据聊天话题查找相关记忆。';
  }
  if (route?.careNeed === 'needs_being_remembered') {
    return '白云听见你想被记得，所以先接住这份需要，再挑能陪你的惦记。';
  }
  if (route?.careNeed === 'needs_companionship') {
    return '白云听见你想被陪着，所以先靠近一点，再挑能陪你的惦记。';
  }
  if (route?.careNeed === 'low_energy') {
    return '白云听见你低精力，所以先接住情绪，再挑一条能陪你的惦记。';
  }
  if (route?.careNeed === 'sensitive') {
    return '白云判断这可能是敏感旧事，所以会想起相关内容，但不逼问细节。';
  }
  if (counts.spoken > 0) return '白云这轮不只想起，也挑了一点适合说出口的关心。';
  if (counts.carePool > 0) return '白云这轮有惦记在心里，但不一定全部说出来。';
  if (counts.recall > 0) return '白云这轮找到了和话题直接相关的记忆。';
  if (counts.background > 0) return '白云这轮主要把记忆放在心里，当作背景参考。';
  return '这一轮没有明显需要带进对话的记忆。';
}

function buildActionHints(
  debug: MemoryBundleDebug,
  counts: { background: number; carePool: number; held: number; recall: number; sourceTraceMatched: number; spoken: number },
) {
  const hints: string[] = [];
  if (counts.recall > 0) hints.push(`${getMemorySpeechPolicy('related').label}：${getMemorySpeechPolicy('related').rule}`);
  if (counts.spoken > 0) hints.push(`${getMemorySpeechPolicy('spoken').label}：${getMemorySpeechPolicy('spoken').rule}`);
  if (
    debug.route?.careNeed === 'low_energy'
    || debug.route?.careNeed === 'needs_companionship'
    || debug.route?.careNeed === 'needs_being_remembered'
  ) {
    hints.push('低精力陪伴：先给情绪价值，再说“我记得”；建议只在小仓鼠主动问怎么办时靠后出现。');
  }
  if (counts.background > 0) hints.push(`${getMemorySpeechPolicy('background').label}：${getMemorySpeechPolicy('background').rule}`);
  if (counts.held > 0) hints.push('“暂时没说”不是忘记，是这轮怕一次说太多。');
  if (debug.counts.anchors) hints.push(`${getMemorySpeechPolicy('anchor').label}：${getMemorySpeechPolicy('anchor').rule}`);
  if (debug.counts.reflections) hints.push(`${getMemorySpeechPolicy('reflection').label}：${getMemorySpeechPolicy('reflection').rule}`);
  if (counts.sourceTraceMatched > 0) hints.push(`${getMemorySpeechPolicy('sourceTrace').label}：${getMemorySpeechPolicy('sourceTrace').rule}`);
  if (debug.counts.sourceTraceCandidates && !debug.counts.sourceTraceMatched) {
    hints.push('这轮想找原文，但没有命中可用片段；白云应该谨慎回答。');
  }
  if (debug.dropped.length) hints.push('有些记忆暂时没带上，可以展开技术细节看原因。');
  hints.push('如果某条不相关，可以点“不相关”；如果以后不想主动提，可以去记忆详情关掉主动提。');
  return hints;
}

function buildDropNotes(debug: MemoryBundleDebug) {
  const counts = new Map<string, number>();
  debug.dropped.forEach((item) => counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1));
  return Array.from(counts.entries()).map(([reason, count]) => `${describeDropReason(reason)}${count > 1 ? ` ${count} 条` : ''}`);
}

function describeDropReason(reason: string) {
  const labels: Record<string, string> = {
    missing: '发送前原卡不可用',
    weekly_stale: '周回顾依据已变化，暂停使用',
    understanding_stale: '认识依据待核对，暂停使用',
    changed_again: '发送前材料再次变化，本轮跳过',
    anchor_limit: '长期坐标太多，先少带几条',
    diversity_long_memory: '相似长记忆太多，先让位',
    duplicate_anchor: '长期坐标重复',
    duplicate_reflection: '白云动态重复',
    duplicate_recall: '和已经想起的记忆太像',
    quiet_context_limit: '背景记忆太多，先少带几条',
    recall_limit: '相关记忆位置已满',
    reflection_limit: '白云动态位置已满',
    spoken_mention_limit: '想到了，但这轮只适合说一点',
    suggested_mention_limit: '主动关心位置已满',
  };
  return labels[reason] ?? reason;
}

function routeLabel(debug: MemoryBundleDebug) {
  const mode = debug.route?.mode;
  if (mode === 'detail_recall') return '需要原文细节';
  if (mode === 'recall') return '认真翻旧事';
  if (mode === 'background_only') return '只作背景';
  return '';
}

function careLabel(debug: MemoryBundleDebug) {
  const careNeed = debug.route?.careNeed;
  if (careNeed === 'low_energy') return '低精力';
  if (careNeed === 'needs_being_remembered') return '想被记住';
  if (careNeed === 'needs_companionship') return '想被陪伴';
  if (careNeed === 'sensitive') return '敏感旧事';
  return '';
}

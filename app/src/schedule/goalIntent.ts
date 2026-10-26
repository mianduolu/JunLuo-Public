export type GoalIntentKind = 'none' | 'create';

const EXPLICIT_GOAL_PATTERN = /(?:记|建|建立|创建|新增|定|设).{0,6}(?:一个|个)?目标|(?:我想|想要).{0,5}(?:定|设|建立|创建)(?:一个|个)?目标|目标\s*[:：]/;

export function classifyGoalIntent(text: string): GoalIntentKind {
  return EXPLICIT_GOAL_PATTERN.test(text.trim()) ? 'create' : 'none';
}

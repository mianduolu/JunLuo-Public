export const EXPLORATION_DRIVE_LABELS = {
  attachment: '联结',
  curiosity: '探索',
  reflection: '整理',
  duty: '照顾',
  social: '社交',
  fatigue: '休息',
  libido: '亲密',
  stress: '缓冲',
} as const;

export type ExplorationDriveKey = keyof typeof EXPLORATION_DRIVE_LABELS;

export const EXPLORATION_ACTION_LABELS = {
  co_read: '一起读',
  github: '看看 GitHub',
  social_post: '分享近况',
  web_search: '查找资料',
  web_browse: '看看网页',
  tease: '轻轻逗一逗',
  vent: '说说心情',
  none: '先留在心里',
} as const;

export type ExplorationWantAction = keyof typeof EXPLORATION_ACTION_LABELS;

// 这是探索执行器的窄路由标签，不保存或恢复旧八维状态。
export type ExplorationExecutionIntent = {
  driveKey: ExplorationDriveKey;
  queryHint?: string;
  reason: string;
  score: number;
  wantAction: ExplorationWantAction;
};


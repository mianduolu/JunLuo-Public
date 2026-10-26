export type ToolRouteSemanticGuardKind =
  | 'explicit_delegation'
  | 'self_narrative'
  | 'future_self_plan'
  | 'negated_request'
  | 'quoted_or_reported_command'
  | 'tool_discussion'
  | 'figurative_chat'
  | 'none';

export type ToolRouteSemanticGuardResult = {
  kind: ToolRouteSemanticGuardKind;
  matchedText?: string;
  shouldProtectFromToolRouting: boolean;
  reason: string;
};

const EXPLICIT_TOOL_DELEGATION_PATTERN =
  /(?:帮我|帮鼠|替我|替鼠|你去|你帮|请你|麻烦你|给我|为我|现在帮我|现在给我|立刻帮我|马上帮我|自动|到点|定时|每天|以后每次).{0,36}(?:打开|启动|播放|点歌|放歌|点击|滑动|输入|发送|发出去|发给|发布|发小红书|发微博|发朋友圈|发帖|点赞|评论|收藏|转发|执行|运行|跑代码|命令|shell|Shizuku|搜索|搜|查|查一下|找|找一下|导航|定位|打开网页|读网页|总结网页|读取网页|分享|拨号|发短信)|(?:把|将).{0,36}(?:发出去|发送|发给|发布|发小红书|发微博|发朋友圈|发帖|分享出去|打开|读一下|总结|保存)|^(?:打开|启动).{0,12}(?:小红书|微信|QQ|星野|微博|网易云|音乐|浏览器|网页|链接|URL|App|app|应用|设置|文件|文档|相册|短信|拨号|通知栏|蓝牙|戒指)/i;

const SELF_NARRATIVE_PATTERN =
  /(?:我|鼠|小仓鼠).{0,12}(?:正在|在|刚才|刚刚|之前|昨天|前天|上次|已经|早就|自己|刚).{0,20}(?:搜|搜索|查|查过|找|找过|看|看过|发|发过|发小红书|发微博|发朋友圈|发帖|发消息|发短信|评论|点赞|收藏|转发|打开|启动|播放|点击|滑动|输入|浏览|读过|用了|试了)|(?:昨天|前天|刚刚|刚才|之前|上次|已经).{0,28}(?:没人点赞|没人评论|没人理|没什么人看|发出去了|发过|评论过|收藏过|打开过|刷到|搜过|查过|看过)|(?:我|鼠|小仓鼠).{0,10}(?:要|想|准备|打算|先|马上|待会|等会|现在|这就)?去(?:上个?厕所|厕所|洗手间|吃饭|睡觉|洗澡|拿(?:个)?快递|修|改|写|做|处理|忙|上班|上课|下班|买|便利店|超市|找|玩|刷|看|休息|躺).{0,20}/;

const FUTURE_SELF_PLAN_PATTERN =
  /(?:我|鼠|小仓鼠).{0,12}(?:明天|今晚|晚上|晚点|之后|以后|回头|周末|下次|准备|打算|想要|想|可能会|要).{0,36}(?:发小红书|发微博|发朋友圈|发帖|发消息|发短信|评论|点赞|收藏|转发|打开|启动|播放|搜|搜索|查|找|看|做|做一个|搭|写|修|改)|(?:明天|今晚|晚上|晚点|之后|以后|回头|周末|下次).{0,12}(?:我|鼠|小仓鼠).{0,30}(?:发|评论|点赞|收藏|转发|打开|播放|搜|查|找|看|做)/;

const NEGATED_TOOL_REQUEST_PATTERN =
  /(?:不用|不要|别|先别|暂时别|不需要|不用你|不用白云|别帮我|不要帮我).{0,28}(?:搜|搜索|查|找|打开|启动|点击|输入|发送|发布|点赞|评论|定位|导航|播放|放歌|设置|创建|新增|修改|改成|删除|关闭|记录|记账|提醒|闹钟|日程|工具|联网|网页|链接)|(?:只是|就只是).{0,18}(?:说说|吐槽|聊聊|举例|讨论)/;

const QUOTED_OR_REPORTED_COMMAND_PATTERN =
  /(?:他说|她说|它说|别人说|教程(?:里)?(?:写|说)|文档(?:里)?(?:写|说)|按钮(?:上)?(?:写|叫)|页面(?:上)?(?:写|说)|提示(?:里)?(?:写|说)|(?:翻译|解释|分析|改写).{0,12})[^“"'「『]{0,30}[“"'「『].{0,100}(?:帮我|打开|点击|搜索|搜一下|查一下|发送|发布|输入|登录).{0,100}[”"'」』]?|[“"'「『].{0,100}(?:帮我|打开|点击|搜索|搜一下|查一下|发送|发布|输入|登录).{0,100}[”"'」』].{0,16}(?:翻译|解释|分析|改写)/;

const TOOL_DISCUSSION_PATTERN =
  /(?:工具|能力|功能|自动化|路由|正则|门卫|风险|接入|实现|支持|敏感|误触发|工具包|调试|测试|prompt).{0,30}(?:小红书|点赞|评论|发布|播放|打开|点击|发送|Shizuku|shell|终端|搜索|搜|查询|查|网页|网站|定位|导航|附近|地图|天气|记账|日程|闹钟|GitHub|issue|MCP|插件)|(?:小红书|点赞|评论|发布|播放|打开|点击|发送|Shizuku|shell|终端|搜索|搜|查询|查|网页|网站|定位|导航|附近|地图|天气|记账|日程|闹钟|GitHub|issue|MCP|插件).{0,30}(?:工具|能力|功能|自动化|路由|正则|门卫|风险|接入|实现|支持|现在能|可以吗|会怎样|怎么办|敏感|误触发|调试|测试|prompt)/i;

const FIGURATIVE_CHAT_PATTERN =
  /打开脑洞|返回主线|启动计划|播放人生\s*BGM|给自己点个赞|搜索(?:脑内|脑子|心里|回忆|灵感|瓜子)|给人生找个来源|网页里迷路|(?:我|鼠|小仓鼠)?.{0,8}收藏(?:了|过)?(?:这个|这段|这句)?.{0,8}(?:回忆|句子|心情|想法|说法|话)|转发快乐|输入(?:情绪|消息框里的提示)|评论一下(?:这个|这段|这种)?(?:说法|想法|表达)/;

export function hasExplicitToolDelegation(text: string) {
  return EXPLICIT_TOOL_DELEGATION_PATTERN.test(text);
}

export function classifyToolRouteUtterance(text: string): ToolRouteSemanticGuardResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: 'none', shouldProtectFromToolRouting: false, reason: 'empty' };
  }

  const protectiveChecks: Array<{ kind: ToolRouteSemanticGuardKind; pattern: RegExp; reason: string }> = [
    { kind: 'negated_request', pattern: NEGATED_TOOL_REQUEST_PATTERN, reason: 'negated_tool_request' },
    { kind: 'quoted_or_reported_command', pattern: QUOTED_OR_REPORTED_COMMAND_PATTERN, reason: 'quoted_or_reported_command' },
    { kind: 'self_narrative', pattern: SELF_NARRATIVE_PATTERN, reason: 'self_narrative' },
    { kind: 'future_self_plan', pattern: FUTURE_SELF_PLAN_PATTERN, reason: 'future_self_plan' },
    { kind: 'tool_discussion', pattern: TOOL_DISCUSSION_PATTERN, reason: 'tool_discussion' },
    { kind: 'figurative_chat', pattern: FIGURATIVE_CHAT_PATTERN, reason: 'figurative_chat' },
  ];

  for (const check of protectiveChecks) {
    const matchedText = matchPattern(trimmed, check.pattern);
    if (matchedText) {
      return {
        kind: check.kind,
        matchedText,
        shouldProtectFromToolRouting: true,
        reason: check.reason,
      };
    }
  }

  const explicit = matchPattern(trimmed, EXPLICIT_TOOL_DELEGATION_PATTERN);
  if (explicit) {
    return {
      kind: 'explicit_delegation',
      matchedText: explicit,
      shouldProtectFromToolRouting: false,
      reason: 'explicit_tool_delegation',
    };
  }

  return { kind: 'none', shouldProtectFromToolRouting: false, reason: 'none' };
}

export function shouldProtectFromBroadToolRouting(text: string) {
  return classifyToolRouteUtterance(text).shouldProtectFromToolRouting;
}

function matchPattern(text: string, pattern: RegExp) {
  const match = pattern.exec(text);
  return match?.[0];
}

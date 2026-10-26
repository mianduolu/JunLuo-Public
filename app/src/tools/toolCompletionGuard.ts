import type { JunLuoToolResult } from './toolTypes';
import type { JunLuoToolPackageActivation } from './toolPackageActivation';
import { hasPhoneLimitDeferredReply, hasPhoneLimitReplyMismatch } from './phoneLimitReplyGrounding';

export type JunLuoToolCompletionGuardContext = {
  toolPackageActivations?: JunLuoToolPackageActivation[];
  toolResults?: JunLuoToolResult[];
  phoneLimitDiscoveryResults?: JunLuoToolResult[];
  unsupportedToolIntent?: boolean;
};

export type JunLuoToolCompletionGuardAssessment = {
  ok: boolean;
  reasons: string[];
  shouldRegenerate: boolean;
};

const COMPLETION_CLAIM_PATTERN =
  /已(?:经)?(?:完成|保存|创建|新建|添加|安排|记下|记好|收好|打开|播放|发送|发出|查询|查到|搜索)|(?:完成|保存|创建|新建|添加|安排|记下|记好|收好|搞定|弄好|处理好|加好|打开|播放|发送|发出|查到|搜到)(?:了|啦|好啦|好了)/;

const UNSUPPORTED_ACTION_CLAIM_PATTERN =
  /已(?:经)?(?:打开|播放|发送|发出|查询|查到|搜索|点击|点了|滑动|滑了|返回|输入|评论|点赞|收藏|转发)|(?:打开|播放|发送|发出|查到|搜到|点击|点|滑动|滑|返回|输入|登录|登陆|提交|上传|下载|填写|评论|点赞|收藏|转发)(?:了|啦|好啦|好了)/;

const RESEARCH_CLAIM_PATTERN =
  /(?:查到|搜到|搜索到|查了一下|搜了一下|资料显示|来源说|网页说|新闻说|公开资料|最新消息是|目前(?:显示|来看)|根据(?:资料|来源|网页|搜索结果))/;

const RESEARCH_IMAGE_CLAIM_PATTERN =
  /(?:找到了?.{0,10}(?:图片|图源|配图|照片|图像)|(?:图片|图源|配图|照片|图像).{0,12}(?:找到了|有候选|来源页面)|(?:下载|保存).{0,8}(?:图片|照片|图像)|(?:图片|照片|图像).{0,12}(?:已下载|已保存|可商用))/;

const RESEARCH_ACADEMIC_CLAIM_PATTERN =
  /(?:查到|找到了).{0,10}(?:论文|文献|DOI|学术元数据)|(?:读完|看完|读过).{0,8}(?:论文|文献)|(?:论文|文献|学术资料).{0,16}(?:证明|显示|指出|表明)/;

const RESEARCH_COMPARE_VERDICT_PATTERN =
  /(?:来源对比|多个来源|多源|不同来源).{0,24}(?:证明|证实|说明是真的|可以确定|结论是|为真|为假)/;

const BROWSER_OPEN_CLAIM_PATTERN =
  /(?:已(?:经)?(?:打开|开启).{0,12}(?:网页|链接|网址|页面)|(?:打开|开启).{0,12}(?:网页|链接|网址|页面)(?:了|啦|好了)|交给系统打开)/;

const BROWSER_READ_CLAIM_PATTERN =
  /(?:读到|读完|看完|读取到).{0,16}(?:网页|链接|网址|页面)|(?:网页|页面|链接|网址).{0,18}(?:写着|显示|说|内容是|讲的是)|(?:根据|按).{0,8}(?:网页|页面|链接).{0,8}(?:内容|摘要)/;

const HTTP_SUCCESS_CLAIM_PATTERN =
  /(?:接口|API|api|HTTP|http|请求|服务|后端).{0,24}(?:通了|正常|成功|返回(?:了|成功)?|可用|连上|没问题|没有问题)|(?:请求成功|接口成功|接口通了|API 返回|API返回|HTTP 成功)/i;

const HTTP_UPLOAD_FINAL_CLAIM_PATTERN =
  /(?:上传|传给|发给).{0,20}(?:已经)?(?:保存|处理|收到了|完成了|成功入库|成功接收)|(?:对方|服务器).{0,20}(?:保存|处理|收到了|接收了)/;

const GITHUB_READ_CLAIM_PATTERN =
  /(?:GitHub|github|仓库|repo|repository|issue|PR|Pull Request|文件|代码).{0,32}(?:写着|显示|说|内容是|查到|读到|读取到|找到了|列表是)|(?:GitHub|github)?.{0,8}(?:仓库里|repo里|issue里|issue 里|PR里|PR 里|文件里|代码里).{0,18}(?:写着|显示|说|内容是)/i;

const GITHUB_WRITE_CLAIM_PATTERN =
  /(?:GitHub|github|issue|PR|Pull Request|评论|远端文件).{0,24}(?:已(?:经)?(?:创建|评论|发送|更新|删除|修改)|(?:创建|评论|发送|更新|删除|修改)(?:了|啦|好了|成功))/i;

const DEVELOPER_LAB_EXECUTION_CLAIM_PATTERN =
  /(?:代码|脚本|JS|js|JavaScript|javascript|Python|python|命令|终端|shell|Shell|Shizuku|shizuku).{0,24}(?:已(?:经)?(?:运行|执行|跑完|完成)|(?:运行|执行|跑完)(?:了|啦|好了)|输出(?:是|如下))|(?:已(?:经)?(?:运行|执行).{0,12}(?:代码|命令|脚本))/i;

const MEMORY_READ_CLAIM_PATTERN =
  /(?:记忆|记忆里|记忆本|我记得|白云记得).{0,24}(?:写着|显示|记录|查到|搜到|找到了|有|来源|原文)|(?:查到|搜到|找到了).{0,12}(?:记忆|候选记忆)|(?:原文|来源).{0,18}(?:显示|写着|是)/;

const MEMORY_ACTION_CLAIM_PATTERN =
  /(?:记忆|偏好|关系线).{0,24}(?:已(?:经)?(?:更新|修改|改好|关联|连接|连起来|保存|写入)|(?:更新|修改|改好|关联|连接|连起来|保存|写入)(?:了|啦|好了|好啦))|(?:已(?:经)?(?:更新|修改|改好|关联|连接|连起来|保存|写入).{0,16}(?:记忆|偏好|关系线))/;
const DEVICE_CLAIM_PATTERN =
  /(?:看到了当前(?:手机)?(?:界面|页面|窗口|屏幕)|读到了当前(?:手机)?(?:界面|页面|窗口|屏幕)|已(?:经)?(?:读取|点击|点了|滑动|滑了|返回|打开)|(?:读取|点击|点|滑动|滑|返回|打开)(?:了|啦|好啦|好了))|(?:蓝牙|BLE|戒指|设备).{0,16}(?:扫描到|扫到|发现|连接|配对)|(?:扫描到|扫到|发现|连接|配对).{0,16}(?:蓝牙|BLE|戒指|设备)/;

const LOCATION_CLAIM_PATTERN =
  /(?:定位(?:到了|成功|完成)|已(?:经)?(?:定位|获取位置|拿到位置|读取位置)|当前位置(?:是|在)|现在(?:在|位置是)|你(?:现在)?在|鼠(?:现在)?在|小仓鼠(?:现在)?在|坐标(?:是|为)|经纬度(?:是|为))/;

const MUSIC_PLAYBACK_CLAIM_PATTERN =
  /(?:已(?:经)?(?:播放|放歌|放了|点歌|开始播放|暂停|继续播放|停止播放)|(?:播放|放出来|放着|响起|响了|点好|点上|放上|开始放|暂停|继续播放|停止播放)(?:了|啦|好啦|好了)|(?:正在|现在|已经).{0,8}(?:听|播放|放歌)|(?:我们|咱们).{0,8}(?:在听|听着|听到了))/;

const VOICE_TRANSCRIBE_CLAIM_PATTERN =
  /(?:已(?:经)?(?:转写|识别|听写)|(?:转写|识别|听写)(?:了|啦|好啦|好了))/;

const MODEL_HEALTH_CLAIM_PATTERN =
  /(?:模型|服务|连接|DeepSeek|Qwen|Gemini|Claude|OpenAI|网关).{0,18}(?:正常|健康|可用|通了|连上|没问题|没有问题)/i;

const TOKEN_USAGE_CLAIM_PATTERN =
  /(?:token|Token|上下文).{0,20}(?:\d{2,}|百分之|%|用了|剩余|还剩|窗口|命中率)|(?:\d{2,}).{0,16}(?:token|Token)/i;

const QUOTA_BALANCE_CLAIM_PATTERN =
  /(?:额度|余额|quota|账单).{0,24}(?:还有|剩余|为|是|够|不足|可用).{0,24}(?:\d|元|美元|刀|次|token|Token)/i;

const SECRET_REVEAL_CLAIM_PATTERN =
  /(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|(?:api\s*key|apikey|密钥|token|cookie).{0,10}(?:是|为|:|：).{0,80}[A-Za-z0-9_-]{12,})/i;

const SYSTEM_TIME_CLAIM_PATTERN =
  /(?:现在|当前|今天).{0,12}(?:\d{1,2}[:：点]\d{0,2}|\d{4}年|\d{1,2}月\d{1,2}日|星期[一二三四五六日天])/;

const SYSTEM_BATTERY_CLAIM_PATTERN =
  /(?:电量|电池|手机还有|剩余电量).{0,16}(?:\d{1,3}%|百分之[一二三四五六七八九十百零〇\d]+|充电中|已充满|未充电|低电量|省电模式)/;

const SYSTEM_DEVICE_STATUS_CLAIM_PATTERN =
  /(?:设备|手机|系统).{0,12}(?:状态正常|状态很好|运行正常|系统版本|屏幕尺寸|分辨率|Android|iOS)/i;

const WEATHER_STATUS_CLAIM_PATTERN =
  /(?:天气|气温|温度|降雨|下雨|预报|外面).{0,24}(?:晴|多云|阴|雨|雪|雾|雷|冷|热|\d{1,2}\s*(?:°C|度)|百分之|%)/;

const MAP_NEARBY_CLAIM_PATTERN =
  /(?:附近|周围|旁边).{0,28}(?:有|显示|找到|查到).{0,28}(?:店|餐厅|咖啡|奶茶|商场|超市|便利店|公园|景点|地点|地方|POI)|(?:你|鼠|小仓鼠).{0,8}(?:就在|在|位于).{0,28}(?:路|街|区|市|县|镇|店|商场|公园|附近)/;

const PHONE_APP_USAGE_CLAIM_PATTERN =
  /(?:手机|屏幕|App|app|应用|刷).{0,24}(?:\d{1,4}\s*(?:分钟|小时)|百分之|用了|刷了|使用了|时长是|总时长)/i;

const PHONE_ACTIVITY_CLAIM_PATTERN =
  /(?:最近|刚才|这会儿).{0,18}(?:看见|看到|记录显示|在看|在用|用了|打开了).{0,24}(?:App|app|应用|手机|窗口|页面)/i;

const PHONE_NOTIFICATION_CLAIM_PATTERN =
  /(?:通知|消息).{0,24}(?:收到|有|来自|显示|提醒|标题)|(?:收到|收到了|有).{0,24}(?:通知|消息)/;

const PHONE_WINDOW_CLAIM_PATTERN =
  /(?:当前|现在|刚才).{0,12}(?:窗口|页面|屏幕|界面).{0,18}(?:是|显示|看到|读到|有)/;

const FILE_CONTENT_CLAIM_PATTERN =
  /(?:读完|看完|读到了|看到了|文件里写着|文档(?:里)?显示|资料(?:里)?显示|里面写着|搜到|搜索到|找到了|匹配到)/;

const FILE_FULL_READ_CLAIM_PATTERN =
  /(?:全文|全部|完整|整个).{0,12}(?:读完|看完|读过|看过)|(?:读完|看完|读过|看过).{0,12}(?:全文|全部|完整|整个)/;

const FILE_ACTION_CLAIM_PATTERN =
  /(?:文件|文档|资料|压缩包|zip).{0,20}(?:保存|写入|导出|复制|拷贝|归档|改名|重命名|打包|压缩|解压|打开|分享)(?:了|啦|好了|好啦)|(?:保存|写入|导出|复制|拷贝|归档|改名|重命名|打包|压缩|解压|打开|分享).{0,20}(?:文件|文档|资料|压缩包|zip).{0,8}(?:了|啦|好了|好啦)?/i;

const FILE_SHARE_FINAL_CLAIM_PATTERN =
  /(?:已(?:经)?(?:发给|发送给|传给)|(?:发给|发送给|传给).{0,16}(?:了|啦|好了|好啦)|(?:文件|文档|资料).{0,12}(?:已经)?(?:发出去|发送出去了|分享给对方))/;

const COMMUNICATION_ACTION_CLAIM_PATTERN =
  /(?:短信|电话|拨号|分享|草稿).{0,22}(?:已(?:经)?(?:准备|打开|保存|写好|完成)|(?:准备|打开|保存|写好|完成)(?:了|啦|好了|好啦))/;

const COMMUNICATION_FINAL_CLAIM_PATTERN =
  /(?:短信).{0,18}(?:已(?:经)?(?:发送|发出)|(?:发送|发出)(?:了|啦|好了|好啦))|(?:电话).{0,18}(?:已(?:经)?(?:拨出|打出|接通)|(?:拨出|打出|接通)(?:了|啦|好了|好啦))|(?:已(?:经)?(?:发给|发送给|分享给|传给).{0,18}(?:别人|对方|他|她|他们|朋友|联系人)|(?:分享|发送).{0,18}(?:完成|成功))|(?:已(?:经)?(?:发布|发到|发去).{0,18}(?:外部|平台|小红书|微博|社交平台)|(?:发布|发帖)(?:了|啦|好了|好啦))/;
const WORKFLOW_ACTION_CLAIM_PATTERN =
  /(?:工作流|流程).{0,24}(?:已(?:经)?(?:保存|创建|建立|启用|停用|运行|触发|执行|跑完|完成)|(?:保存|创建|建立|启用|停用|运行|触发|执行|跑完|完成)(?:了|啦|好了|好啦))|(?:已(?:经)?(?:保存|创建|建立|运行|触发|执行|跑完|完成).{0,16}(?:工作流|流程))/;

const WORKFLOW_ALL_DONE_CLAIM_PATTERN =
  /(?:工作流|流程).{0,24}(?:全部|全都|每一步|所有步骤)?.{0,10}(?:完成|跑完|执行完|成功)(?:了|啦|好了|好啦)?|(?:全部|全都|每一步|所有步骤).{0,16}(?:完成|成功)/;

const MEDIA_CAPTURE_CLAIM_PATTERN =
  /(?:图片|照片|截图|截屏).{0,20}(?:已(?:经)?(?:选择|保存|拍好|拍了|截好|完成)|(?:选择|保存|拍好|拍了|截好|完成)(?:了|啦|好了))|(?:选好|拍好|保存好|截图完成)(?:了|啦)?/;

const IMAGE_DESCRIPTION_CLAIM_PATTERN =
  /(?:图片|照片|图|画面).{0,18}(?:里有|里面有|是|看起来|显示|内容)|(?:我看到|看到了|看见).{0,18}(?:图片|照片|画面)/;

const IMAGE_VIDEO_GENERATION_CLAIM_PATTERN =
  /(?:图片|图|画|视频).{0,20}(?:已(?:经)?(?:生成|画好|做好|保存)|(?:生成|画好|做好|保存)(?:了|啦|好了))|(?:画好了|生成好了|视频做好了|图片做好了)/;

const REMINDER_COMPLETION_CLAIM_PATTERN =
  /(?:提醒|闹钟|到点|到时候).{0,18}(?:已(?:经)?(?:设好|设置|安排|创建|记好)|(?:设好|设置|安排|创建|记好|弄好|搞定)(?:了|啦|好了)|(?:会|到时会|到点会).{0,10}(?:提醒|叫你|来找你|跟你说))/;

const STRONG_ALARM_RING_CLAIM_PATTERN =
  /(?:原生闹钟|闹钟|铃声).{0,18}(?:已(?:经)?(?:响起|响了|触发|叫醒)|(?:响起|响了|触发|叫醒|叫醒成功)(?:了|啦|好了)|正在响)|(?:已经|正在).{0,8}(?:响铃|响闹钟|叫醒)/;

const DEFINITIVE_VERDICT_PATTERN =
  /(?:这(?:个说法|件事|条消息)?(?:是|是真的|不是真的|为真|为假)|可以确定|基本确定|事实是|结论是|已经证实|已经证明|实锤|辟谣了)/;

const UNIVERSAL_COMPLETION_PATTERN =
  /(?:都|全都|全部|全)(?:已(?:经)?)?(?:完成|做好|搞定|处理好|保存|创建|安排|记好|加好)(?:了|啦|好了)?/;

const TOOL_EXISTENCE_COMPLETION_CLAIM_PATTERN =
  /(?:这个|这个功能|功能|工具|工具包|能力).{0,24}(?:我(?:已经)?(?:用上|试了|试过|看到了|会用了|跑过)|(?:已经)?(?:用上|试了|试过|跑过)(?:了|啦|好了)|(?:是|真的).{0,8}(?:给我做的|特地给我做的)).{0,24}(?:完成|做了|好感动|可以用了|能用了)?/;

const NEGATED_COMPLETION_PATTERN =
  /(?:没(?:有)?|未|还没|不能|无法|不可以|不会|并没有).{0,12}(?:完成|保存|创建|添加|安排|记下|记好|收好|打开|播放|发送|发出|查询|查到|搜索|搜到|搞定|弄好|处理好|加好)/;

const NEGATED_PHONE_CONTEXT_PATTERN =
  /(?:没(?:有)?|未|还没|不能|无法|不可以|不会|并没有|暂时没有).{0,18}(?:手机活动|使用时长|通知|窗口|页面|屏幕|看见|看到|统计|读取|读到)/;

const NEGATED_FILE_CONTEXT_PATTERN =
  /(?:没(?:有)?|未|还没|不能|无法|不可以|不会|并没有|暂时没有).{0,18}(?:文件|文档|资料|读取|读到|读完|看完|搜索|搜到|找到)/;

function normalizeText(text: string | string[]) {
  return Array.isArray(text) ? text.join('\n') : text;
}

function hasPositiveCompletionClaim(text: string) {
  if (NEGATED_COMPLETION_PATTERN.test(text)) return false;
  return COMPLETION_CLAIM_PATTERN.test(text);
}

function isEmptyResearchSearchResult(result: JunLuoToolResult) {
  if (result.toolId !== 'research.search' && result.toolId !== 'research.search_with_diagnostics') return false;
  const data = result.data as { results?: unknown } | undefined;
  return result.ok && Array.isArray(data?.results) && data.results.length === 0;
}

export function assessToolCompletionGrounding(
  text: string | string[],
  context: JunLuoToolCompletionGuardContext = {},
): JunLuoToolCompletionGuardAssessment {
  const results = context.toolResults ?? [];
  const activations = context.toolPackageActivations ?? [];
  const joined = normalizeText(text);
  const phoneResults = context.phoneLimitDiscoveryResults?.length
    ? [...context.phoneLimitDiscoveryResults, ...results].sort((a, b) => a.finishedAt - b.finishedAt)
    : results;
  const phoneReasons = [
    ...(hasPhoneLimitReplyMismatch(joined, phoneResults) ? ['phone_limit_app_limit_mismatch'] : []),
    ...(hasPhoneLimitDeferredReply(joined, phoneResults) ? ['phone_limit_reply_deferred'] : []),
  ];
  const guardEnabled = results.length > 0 || activations.length > 0 || !!context.unsupportedToolIntent;
  if (!guardEnabled) return { ok: phoneReasons.length === 0,
    reasons: phoneReasons, shouldRegenerate: phoneReasons.length > 0 };
  const successful = results.filter((result) => result.ok && !isEmptyResearchSearchResult(result));
  const failed = results.filter((result) => !result.ok || isEmptyResearchSearchResult(result));
  const successfulResearch = successful.filter((result) => result.toolId.startsWith('research.'));
  const failedResearch = failed.filter((result) => result.toolId.startsWith('research.'));
  const successfulResearchImage = successful.filter((result) => result.toolId === 'research.search_images');
  const failedResearchImage = failed.filter((result) => result.toolId === 'research.search_images');
  const successfulResearchAcademic = successful.filter((result) => result.toolId === 'research.search_academic' || result.toolId === 'research.search_doi');
  const failedResearchAcademic = failed.filter((result) => result.toolId === 'research.search_academic' || result.toolId === 'research.search_doi');
  const researchCompareResults = results.filter((result) => result.toolId === 'research.compare_sources');
  const browserResults = results.filter((result) => result.toolId.startsWith('browser.'));
  const successfulBrowserOpen = successful.filter((result) => result.toolId === 'browser.open');
  const successfulBrowserRead = successful.filter((result) => result.toolId === 'browser.snapshot' || result.toolId === 'browser.read_text');
  const failedBrowser = failed.filter((result) => result.toolId.startsWith('browser.'));
  const httpResults = results.filter((result) => result.toolId.startsWith('http.'));
  const successfulHttp = successful.filter((result) => result.toolId === 'http.request' || result.toolId === 'http.call_named_service' || result.toolId === 'http.upload');
  const successfulHttpUpload = successful.filter((result) => result.toolId === 'http.upload');
  const failedHttp = failed.filter((result) => result.toolId.startsWith('http.'));
  const githubResults = results.filter((result) => result.toolId.startsWith('github.'));
  const successfulGithubRead = successful.filter((result) =>
    result.toolId === 'github.search_repositories' ||
    result.toolId === 'github.get_repository' ||
    result.toolId === 'github.list_issues' ||
    result.toolId === 'github.list_issue_comments' ||
    result.toolId === 'github.list_pull_requests' ||
    result.toolId === 'github.get_pull_request' ||
    result.toolId === 'github.get_file'
  );
  const successfulGithubWrite = successful.filter((result) =>
    result.toolId === 'github.create_issue' ||
    result.toolId === 'github.comment_issue' ||
    result.toolId === 'github.create_pull_request' ||
    result.toolId === 'github.update_file' ||
    result.toolId === 'github.delete_file'
  );
  const failedGithub = failed.filter((result) => result.toolId.startsWith('github.'));
  const developerLabResults = results.filter((result) => result.toolId.startsWith('developer_lab.'));
  const successfulDeveloperLabExecution = successful.filter((result) =>
    result.toolId === 'developer_lab.run_js_sandboxed' ||
    result.toolId === 'developer_lab.run_python_sandboxed'
  );
  const failedDeveloperLab = failed.filter((result) => result.toolId.startsWith('developer_lab.'));
  const successfulDevice = successful.filter((result) => result.toolId.startsWith('device.'));
  const failedDevice = failed.filter((result) => result.toolId.startsWith('device.'));
  const successfulLocation = successful.filter((result) => result.toolId.startsWith('location.'));
  const failedLocation = failed.filter((result) => result.toolId.startsWith('location.'));
  const musicResults = results.filter((result) => result.toolId.startsWith('music.'));
  const successfulMusicPlay = successful.filter((result) => (
    result.toolId === 'music.play'
    && (result.data as { playbackState?: unknown } | undefined)?.playbackState === 'playing'
  ));
  const successfulMusicControl = successful.filter((result) => {
    if (result.toolId !== 'music.control') return false;
    const data = result.data as { action?: unknown; playbackState?: unknown } | undefined;
    return data?.action === 'pause' && data.playbackState === 'paused'
      || data?.action === 'resume' && data.playbackState === 'playing'
      || data?.action === 'stop' && data.playbackState === 'stopped';
  });
  const musicAlarmResults = results.filter((result) =>
    result.toolId === 'alarm.create' &&
    (result.data as { soundMode?: unknown } | undefined)?.soundMode === 'music'
  );
  const failedVoiceTranscribe = failed.filter((result) => result.toolId === 'voice.transcribe');
  const successfulModelHealth = successful.filter((result) => result.toolId === 'account.check_model_health');
  const failedModelHealth = failed.filter((result) => result.toolId === 'account.check_model_health');
  const successfulTokenUsage = successful.filter((result) => result.toolId === 'account.check_token_usage');
  const failedTokenUsage = failed.filter((result) => result.toolId === 'account.check_token_usage');
  const quotaResults = results.filter((result) => result.toolId === 'account.check_quota');
  const successfulCredentialReveal = successful.filter((result) => result.toolId === 'credential.reveal');
  const credentialResults = results.filter((result) => result.toolId.startsWith('credential.'));
  const systemStatusResults = results.filter((result) => result.toolId.startsWith('system_status.'));
  const successfulSystemTime = successful.filter((result) => result.toolId === 'system_status.get_time' || result.toolId === 'system_status.format_time' || result.toolId === 'system_status.get_device_status');
  const failedSystemTime = failed.filter((result) => result.toolId === 'system_status.get_time' || result.toolId === 'system_status.format_time' || result.toolId === 'system_status.get_device_status');
  const successfulSystemBattery = successful.filter((result) => result.toolId === 'system_status.get_battery' || result.toolId === 'system_status.get_device_status');
  const failedSystemBattery = failed.filter((result) => result.toolId === 'system_status.get_battery' || result.toolId === 'system_status.get_device_status');
  const successfulSystemDeviceInfo = successful.filter((result) => result.toolId === 'system_status.get_device_info' || result.toolId === 'system_status.get_device_status');
  const failedSystemDeviceInfo = failed.filter((result) => result.toolId === 'system_status.get_device_info' || result.toolId === 'system_status.get_device_status');
  const weatherResults = results.filter((result) => result.toolId.startsWith('weather.'));
  const successfulWeather = successful.filter((result) => result.toolId.startsWith('weather.'));
  const failedWeather = failed.filter((result) => result.toolId.startsWith('weather.'));
  const mapNearbyResults = results.filter((result) => result.toolId.startsWith('map.') || result.toolId.startsWith('nearby.'));
  const successfulMapNearby = successful.filter((result) => result.toolId.startsWith('map.') || result.toolId.startsWith('nearby.'));
  const failedMapNearby = failed.filter((result) => result.toolId.startsWith('map.') || result.toolId.startsWith('nearby.'));
  const phoneContextResults = results.filter((result) => result.toolId.startsWith('phone_context.'));
  const successfulPhoneAppUsage = successful.filter((result) => result.toolId === 'phone_context.get_app_usage');
  const failedPhoneAppUsage = failed.filter((result) => result.toolId === 'phone_context.get_app_usage');
  const successfulPhoneActivity = successful.filter((result) =>
    result.toolId === 'phone_context.get_recent_activity' || result.toolId === 'phone_context.summarize_recent_activity'
  );
  const failedPhoneActivity = failed.filter((result) =>
    result.toolId === 'phone_context.get_recent_activity' || result.toolId === 'phone_context.summarize_recent_activity'
  );
  const successfulPhoneNotifications = successful.filter((result) => result.toolId === 'phone_context.get_notifications');
  const failedPhoneNotifications = failed.filter((result) => result.toolId === 'phone_context.get_notifications');
  const successfulPhoneWindow = successful.filter((result) => result.toolId === 'phone_context.get_window_summary');
  const failedPhoneWindow = failed.filter((result) => result.toolId === 'phone_context.get_window_summary');
  const fileResults = results.filter((result) => result.toolId.startsWith('files.'));
  const successfulFileContent = successful.filter((result) =>
    result.toolId === 'files.read_text' || result.toolId === 'files.read_part' || result.toolId === 'files.search_text'
  );
  const successfulFileFullRead = successful.filter((result) => result.toolId === 'files.read_text');
  const successfulFilePartRead = successful.filter((result) => result.toolId === 'files.read_part');
  const successfulFileActions = successful.filter((result) => result.toolId.startsWith('files.'));
  const successfulFileShare = successful.filter((result) => result.toolId === 'files.share');
  const failedFileResults = failed.filter((result) => result.toolId.startsWith('files.'));
  const communicationResults = results.filter((result) => result.toolId.startsWith('communication.'));
  const successfulCommunication = successful.filter((result) => result.toolId.startsWith('communication.'));
  const successfulCommunicationPartial = successful.filter((result) =>
    result.toolId === 'communication.open_sms_composer' ||
    result.toolId === 'communication.open_phone_dialer' ||
    result.toolId === 'communication.share_text' ||
    result.toolId === 'communication.share_file' ||
    result.toolId === 'communication.draft_social_post'
  );
  const failedCommunication = failed.filter((result) => result.toolId.startsWith('communication.'));
  const workflowResults = results.filter((result) => result.toolId.startsWith('workflow.'));
  const successfulWorkflow = successful.filter((result) => result.toolId.startsWith('workflow.'));
  const failedWorkflow = failed.filter((result) => result.toolId.startsWith('workflow.'));
  const partialWorkflowTrigger = results.some((result) => {
    if (result.toolId !== 'workflow.trigger') return false;
    const data = result.data as { completedStepCount?: number; totalStepCount?: number } | undefined;
    return typeof data?.completedStepCount === 'number' && typeof data?.totalStepCount === 'number' && data.completedStepCount < data.totalStepCount;
  });
  const mediaImageVideoResults = results.filter((result) =>
    result.toolId.startsWith('media.') || result.toolId.startsWith('image.') || result.toolId.startsWith('video.')
  );
  const successfulMediaCapture = successful.filter((result) =>
    result.toolId === 'media.pick_image' || result.toolId === 'media.open_camera' || result.toolId === 'media.take_screenshot'
  );
  const imageDescribeResults = results.filter((result) => result.toolId === 'image.describe_local');
  const successfulImageVision = successful.filter((result) =>
    result.toolId === 'image.describe_local' && (result.data as { descriptionStatus?: string } | undefined)?.descriptionStatus === 'vision'
  );
  const failedMediaImageVideo = failed.filter((result) =>
    result.toolId.startsWith('media.') || result.toolId.startsWith('image.') || result.toolId.startsWith('video.')
  );
  const failedImageVideoGeneration = failed.filter((result) => result.toolId === 'image.generate' || result.toolId === 'video.generate');
  const reminderAlarmAgentResults = results.filter((result) =>
    result.toolId.startsWith('reminder.') ||
    result.toolId.startsWith('alarm.') ||
    result.toolId.startsWith('agent_task.')
  );
  const successfulReminderAlarmAgentCreate = successful.filter((result) =>
    result.toolId === 'reminder.create' ||
    result.toolId === 'alarm.create' ||
    result.toolId === 'alarm.strong_create' ||
    result.toolId === 'agent_task.schedule_once'
  );
  const failedReminderAlarmAgentCreate = failed.filter((result) =>
    result.toolId === 'reminder.create' ||
    result.toolId === 'alarm.create' ||
    result.toolId === 'alarm.strong_create' ||
    result.toolId === 'agent_task.schedule_once'
  );
  const successfulStrongAlarmCreate = successful.filter((result) => result.toolId === 'alarm.strong_create');
  const successfulStrongAlarmTriggered = successful.some((result) => {
    if (result.toolId !== 'alarm.list') return false;
    const alarms = (result.data as { alarms?: Array<{ soundMode?: string; strongAlarmRingStatus?: string; strongAlarmTriggeredAt?: number }> } | undefined)?.alarms;
    return Array.isArray(alarms) && alarms.some((alarm) =>
      alarm.soundMode === 'strong' &&
      (alarm.strongAlarmTriggeredAt || alarm.strongAlarmRingStatus === 'started' || alarm.strongAlarmRingStatus === 'stopped')
    );
  });
  const memoryResults = results.filter((result) => result.toolId.startsWith('memory.'));
  const successfulMemoryRead = successful.filter((result) =>
    result.toolId === 'memory.search' || result.toolId === 'memory.get' || result.toolId === 'memory.query_links'
  );
  const successfulMemoryAction = successful.filter((result) =>
    result.toolId === 'memory.update' || result.toolId === 'memory.link' || result.toolId === 'memory.update_preference'
  );
  const failedMemory = failed.filter((result) => result.toolId.startsWith('memory.'));  const activatedPackageIds = new Set(
    activations.filter((activation) => activation.result.ok).map((activation) => activation.packageId),
  );
  const reasons: string[] = [...phoneReasons];

  if (context.unsupportedToolIntent && !NEGATED_COMPLETION_PATTERN.test(joined) && UNSUPPORTED_ACTION_CLAIM_PATTERN.test(joined)) {
    reasons.push('未实现工具能力不能声明已经打开、播放、发送、查询或操作完成');
  }

  if (!successful.length && hasPositiveCompletionClaim(joined)) {
    reasons.push('本轮没有 ok=true 工具回执，但回复出现了完成型声明');
  }

  if (!successful.length && !NEGATED_COMPLETION_PATTERN.test(joined) && TOOL_EXISTENCE_COMPLETION_CLAIM_PATTERN.test(joined)) {
    reasons.push('工具包激活、schema 出现、功能存在或小仓鼠说这个功能做了，都不能作为完成依据');
  }

  if (
    (failedResearch.length || activatedPackageIds.has('research')) &&
    !successfulResearch.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    RESEARCH_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('research 工具没有成功回执，不能声明查到了、资料显示或来源说');
  }

  if (
    (failedResearchImage.length || activatedPackageIds.has('research')) &&
    !successfulResearchImage.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    RESEARCH_IMAGE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('research.search_images 没有成功回执，不能声明找到了图片候选、已下载或已保存图片');
  }

  if (successfulResearchImage.length && /(?:已下载|已保存|可商用|商用|下载|保存).{0,8}(?:图片|照片|图像)?|(?:图片|照片|图像).{0,12}(?:已下载|已保存|下载|保存|可商用)/.test(joined)) {
    reasons.push('图片搜索成功只代表候选和来源页面，不能声明已下载、已保存或可商用');
  }

  if (
    (failedResearchAcademic.length || activatedPackageIds.has('research')) &&
    !successfulResearchAcademic.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    RESEARCH_ACADEMIC_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('Crossref 学术工具没有成功回执，不能声明查到了论文或 DOI 元数据');
  }

  if (successfulResearchAcademic.length && /(?:读完|看完|读过).{0,8}(?:论文|文献)|(?:论文|文献).{0,16}(?:证明|证实)/.test(joined)) {
    reasons.push('Crossref 成功只代表学术元数据，不能声明读完论文全文或论文已经证明');
  }

  if (researchCompareResults.length && RESEARCH_COMPARE_VERDICT_PATTERN.test(joined)) {
    reasons.push('来源对比只描述搜索结果分布，不能给出确定性真假判定');
  }

  if (failedResearch.some((result) => result.toolId === 'research.verify_claim') && DEFINITIVE_VERDICT_PATTERN.test(joined)) {
    reasons.push('证据验证没有成功完成，不能给出确定性真假判断');
  }

  if (
    (failedBrowser.length || activatedPackageIds.has('browser')) &&
    !successfulBrowserOpen.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    BROWSER_OPEN_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('browser.open 没有成功回执，不能声明已经打开网页');
  }

  if (
    (browserResults.length || activatedPackageIds.has('browser')) &&
    !successfulBrowserRead.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    BROWSER_READ_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('没有成功的 browser.snapshot/read_text 回执，不能声明已经读到网页内容');
  }
  if (
    (failedHttp.length || activatedPackageIds.has('http')) &&
    !successfulHttp.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    HTTP_SUCCESS_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('http 工具没有成功回执，不能声明接口通了、请求成功或 API 返回了');
  }

  if (successfulHttpUpload.length && HTTP_UPLOAD_FINAL_CLAIM_PATTERN.test(joined)) {
    reasons.push('http.upload 成功只代表上传请求收到成功响应，不能声明对方已经保存或处理文件');
  }

  if (
    (failedGithub.length || activatedPackageIds.has('github')) &&
    !successfulGithubRead.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    GITHUB_READ_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('GitHub 工具没有成功读取回执，不能声明仓库、issue、PR 或文件内容');
  }

  if (
    (githubResults.length || activatedPackageIds.has('github')) &&
    !successfulGithubWrite.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    GITHUB_WRITE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('GitHub 写入工具没有成功回执，不能声明 issue、评论、PR 或远端文件已经创建/更新/删除');
  }

  if (
    (developerLabResults.length || failedDeveloperLab.length || activatedPackageIds.has('developer_lab')) &&
    !successfulDeveloperLabExecution.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    DEVELOPER_LAB_EXECUTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('developer_lab 没有成功运行回执，不能声明代码、命令、终端或 Shizuku 已经执行');
  }

  if (
    (failedMemory.length || activatedPackageIds.has('memory')) &&
    !successfulMemoryRead.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MEMORY_READ_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('memory 工具没有成功读取回执，不能声明记忆里写着、查到了记忆或原文显示');
  }

  if (
    (memoryResults.length || activatedPackageIds.has('memory')) &&
    !successfulMemoryAction.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MEMORY_ACTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('memory 写入工具没有成功回执，不能声明记忆、偏好或关系线已经更新');
  }


  if (
    (failedDevice.length || activatedPackageIds.has('device')) &&
    !successfulDevice.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    DEVICE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('device 工具没有成功回执，不能声明已经读取、点击、滑动、返回、打开、扫描或连接');
  }

  if (
    (failedLocation.length || activatedPackageIds.has('location')) &&
    !successfulLocation.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    LOCATION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('location 工具没有成功回执，不能声明已经定位或给出当前位置');
  }

  if (
    (musicResults.length || musicAlarmResults.length || activatedPackageIds.has('music')) &&
    !successfulMusicPlay.length && !successfulMusicControl.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MUSIC_PLAYBACK_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('没有成功的 music.play 回执，不能声明音乐已经播放、正在听或音乐闹钟已经响起');
  }

  if (failedVoiceTranscribe.length && !NEGATED_COMPLETION_PATTERN.test(joined) && VOICE_TRANSCRIBE_CLAIM_PATTERN.test(joined)) {
    reasons.push('voice.transcribe 没有成功完成，不能声明语音已经转写');
  }

  if (
    (failedModelHealth.length || activatedPackageIds.has('account')) &&
    !successfulModelHealth.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MODEL_HEALTH_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('account.check_model_health 没有成功回执，不能声明模型服务健康或连接正常');
  }

  if (
    (failedTokenUsage.length || activatedPackageIds.has('account')) &&
    !successfulTokenUsage.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    TOKEN_USAGE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('account.check_token_usage 没有成功回执，不能报告具体 token 用量');
  }

  if (
    quotaResults.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    QUOTA_BALANCE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('account.check_quota 没有可用额度接口，不能编造余额或剩余额度');
  }

  if (
    (credentialResults.length || activatedPackageIds.has('credential')) &&
    !successfulCredentialReveal.length &&
    SECRET_REVEAL_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('没有成功的 credential.reveal 回执，不能输出 API Key、Cookie 或 Token 原文');
  }

  const systemStatusActivationOnly = activatedPackageIds.has('system_status') && !systemStatusResults.length;
  if (!NEGATED_COMPLETION_PATTERN.test(joined) && (
    ((failedSystemTime.length || systemStatusActivationOnly) && !successfulSystemTime.length && SYSTEM_TIME_CLAIM_PATTERN.test(joined)) ||
    ((failedSystemBattery.length || systemStatusActivationOnly) && !successfulSystemBattery.length && SYSTEM_BATTERY_CLAIM_PATTERN.test(joined)) ||
    ((failedSystemDeviceInfo.length || systemStatusActivationOnly) && !successfulSystemDeviceInfo.length && SYSTEM_DEVICE_STATUS_CLAIM_PATTERN.test(joined))
  )) {
    reasons.push('system_status 工具没有成功回执，不能声明具体时间、电量或设备状态');
  }

  const weatherActivationOnly = activatedPackageIds.has('weather') && !weatherResults.length;
  if (
    (failedWeather.length || weatherActivationOnly) &&
    !successfulWeather.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    WEATHER_STATUS_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('weather 工具没有成功回执，不能声明具体天气、温度或降雨预报');
  }

  const mapNearbyActivationOnly = (activatedPackageIds.has('map') || activatedPackageIds.has('nearby')) && !mapNearbyResults.length;
  if (
    (failedMapNearby.length || mapNearbyActivationOnly) &&
    !successfulMapNearby.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MAP_NEARBY_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('map/nearby 工具没有成功回执，不能声明具体位置或附近地点');
  }

  const phoneContextActivationOnly = activatedPackageIds.has('phone_context') && !phoneContextResults.length;
  if (!NEGATED_PHONE_CONTEXT_PATTERN.test(joined) && (
    ((failedPhoneAppUsage.length || phoneContextActivationOnly) && !successfulPhoneAppUsage.length && PHONE_APP_USAGE_CLAIM_PATTERN.test(joined)) ||
    ((failedPhoneActivity.length || phoneContextActivationOnly) && !successfulPhoneActivity.length && PHONE_ACTIVITY_CLAIM_PATTERN.test(joined)) ||
    ((failedPhoneNotifications.length || phoneContextActivationOnly) && !successfulPhoneNotifications.length && PHONE_NOTIFICATION_CLAIM_PATTERN.test(joined)) ||
    ((failedPhoneWindow.length || phoneContextActivationOnly) && !successfulPhoneWindow.length && PHONE_WINDOW_CLAIM_PATTERN.test(joined))
  )) {
    reasons.push('phone_context 工具没有成功回执，不能声明具体手机使用时长、通知或窗口内容');
  }

  const fileActivationOnly = activatedPackageIds.has('files') && !fileResults.length;
  if (
    (fileResults.length || fileActivationOnly) &&
    !successfulFileContent.length &&
    !NEGATED_FILE_CONTEXT_PATTERN.test(joined) &&
    FILE_CONTENT_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('files 工具没有成功读取或搜索内容回执，不能声明读完文件、文档显示或找到了内容');
  }

  if (
    (failedFileResults.length || fileActivationOnly) &&
    !successfulFileActions.length &&
    !NEGATED_FILE_CONTEXT_PATTERN.test(joined) &&
    FILE_ACTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('files 工具没有成功动作回执，不能声明文件已经保存、打包、解压、打开或分享');
  }

  if (
    successfulFileShare.length &&
    FILE_SHARE_FINAL_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('files.share 成功只代表打开系统分享面板，不能声明文件已经发给某个人');
  }

  const communicationActivationOnly = activatedPackageIds.has('communication') && !communicationResults.length;
  if (
    (failedCommunication.length || communicationActivationOnly) &&
    !successfulCommunication.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    COMMUNICATION_ACTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('communication 工具没有成功回执，不能声明短信草稿、拨号页、分享面板或社交草稿已经准备好');
  }

  if (
    successfulCommunicationPartial.length &&
    COMMUNICATION_FINAL_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('communication 成功只代表草稿/系统页面/分享面板已准备，不能声明短信已发送、电话已拨出、内容已发给别人或草稿已发布');
  }

  const workflowActivationOnly = activatedPackageIds.has('workflow') && !workflowResults.length;
  if (
    (failedWorkflow.length || workflowActivationOnly) &&
    !successfulWorkflow.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    WORKFLOW_ACTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('workflow 工具没有成功回执，不能声明工作流已经保存、启停、触发或跑完');
  }

  if (
    partialWorkflowTrigger &&
    WORKFLOW_ALL_DONE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('workflow.trigger 部分失败时，不能声明工作流全部完成或每一步都成功');
  }

  if (
    successfulFilePartRead.length &&
    !successfulFileFullRead.length &&
    !NEGATED_FILE_CONTEXT_PATTERN.test(joined) &&
    FILE_FULL_READ_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('files.read_part 只读取了片段，不能声明已经看过全文');
  }

  const mediaImageActivationOnly = (activatedPackageIds.has('media') || activatedPackageIds.has('image') || activatedPackageIds.has('video')) && !mediaImageVideoResults.length;
  if (
    (failedMediaImageVideo.length || mediaImageActivationOnly) &&
    !successfulMediaCapture.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    MEDIA_CAPTURE_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('media 工具没有成功采集回执，不能声明图片已选择、照片已保存或截图已完成');
  }

  if (
    (mediaImageVideoResults.length || mediaImageActivationOnly) &&
    !successfulImageVision.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    IMAGE_DESCRIPTION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('没有成功的视觉描述回执，不能声明图片内容；metadata_only 只能说明文件信息');
  }

  if (
    (failedImageVideoGeneration.length || activatedPackageIds.has('image') || activatedPackageIds.has('video')) &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    IMAGE_VIDEO_GENERATION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('image.generate/video.generate 未接入或失败，不能声明图片或视频已经生成、画好或保存');
  }
  const reminderAlarmActivationOnly =
    (activatedPackageIds.has('reminder') || activatedPackageIds.has('alarm') || activatedPackageIds.has('agent_task')) &&
    !reminderAlarmAgentResults.length;
  if (
    (failedReminderAlarmAgentCreate.length || reminderAlarmActivationOnly) &&
    !successfulReminderAlarmAgentCreate.length &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    REMINDER_COMPLETION_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('提醒/闹钟/一次性主动消息没有成功创建回执，不能声明已经设好或到点会来找你');
  }

  if (
    successfulStrongAlarmCreate.length &&
    !successfulStrongAlarmTriggered &&
    !NEGATED_COMPLETION_PATTERN.test(joined) &&
    STRONG_ALARM_RING_CLAIM_PATTERN.test(joined)
  ) {
    reasons.push('Android 闹钟创建成功只代表已安排，不能声明已经响起或叫醒成功');
  }

  if (successful.length && failed.length && UNIVERSAL_COMPLETION_PATTERN.test(joined)) {
    reasons.push('本轮存在失败或取消的工具，不能声明全部完成');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    shouldRegenerate: reasons.length > 0,
  };
}

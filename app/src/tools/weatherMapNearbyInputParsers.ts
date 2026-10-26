import { shouldProtectFromBroadToolRouting } from './toolRouteSemanticGuards';

const WEATHER_CURRENT_PATTERN =
  /(?:天气|气温|温度|冷不冷|热不热|下雨|会不会雨|雨大吗|风大吗|外面冷吗|外面热吗)/;

const WEATHER_FORECAST_PATTERN =
  /(?:预报|明天|后天|未来|这几天|今天会不会|今天要不要|会不会下雨|会下雨吗|会不会雨)/;

const NEARBY_SEARCH_PATTERN =
  /(?:附近|周围|旁边|附近有什么|周围有什么|吃的|餐厅|饭店|咖啡|奶茶|便利店|超市|公园|景点|商场|店)/;

const LOCATION_CONSISTENCY_PATTERN =
  /(?:定位|位置|附近世界|天气位置).{0,16}(?:准不准|漂|飘|偏|不对|冲突|一致)/;

const NEARBY_CONTEXT_PATTERN =
  /(?:附近世界|周围环境|附近环境|附近参照|路边参照|附近状态).{0,16}(?:摘要|说说|看看|读取|描述|状态)?/;

export function routeWeatherMapNearbyIntent(text: string): { candidateTools: string[]; reason: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (shouldProtectFromBroadToolRouting(trimmed) && !hasExplicitMapNavigationCue(trimmed)) {
    return null;
  }

  if (LOCATION_CONSISTENCY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['nearby.verify_location_consistency'],
      reason: 'nearby_location_consistency',
    };
  }

  if (NEARBY_CONTEXT_PATTERN.test(trimmed) && !/设置|开启|关闭|后台|精度模式/.test(trimmed)) {
    return {
      candidateTools: ['nearby.describe_place_context'],
      reason: 'nearby_place_context',
    };
  }

  if (looksLikeDestinationSearch(trimmed)) {
    return {
      candidateTools: ['map.search_destination'],
      reason: 'map_search_destination',
    };
  }

  if (NEARBY_SEARCH_PATTERN.test(trimmed) && /附近|周围|旁边|吃的|餐厅|咖啡|奶茶|便利店|超市|公园|景点|商场|店/.test(trimmed)) {
    return {
      candidateTools: ['map.search_nearby'],
      reason: 'map_search_nearby',
    };
  }

  if (WEATHER_CURRENT_PATTERN.test(trimmed)) {
    return {
      candidateTools: [WEATHER_FORECAST_PATTERN.test(trimmed) ? 'weather.get_forecast' : 'weather.get_current'],
      reason: WEATHER_FORECAST_PATTERN.test(trimmed) ? 'weather_forecast' : 'weather_current',
    };
  }

  return null;
}

export function parseWeatherCurrentInputFromText(text: string) {
  return {
    allowStoredFallback: !/(?:不要|别).{0,6}(?:缓存|旧天气|上次)/.test(text),
  };
}

export function parseWeatherForecastInputFromText(text: string) {
  const days = /一周|7\s*天|七天/.test(text)
    ? 7
    : /三天|3\s*天/.test(text)
      ? 3
      : 2;
  return { days };
}

export function parseMapSearchNearbyInputFromText(text: string) {
  const query = extractNearbyQuery(text);
  const category = /吃|饭|餐厅|咖啡|奶茶|小吃|夜宵/.test(text)
    ? 'food'
    : /公园|景点|风景|逛逛|走走/.test(text)
      ? 'scenery'
      : /商场|超市|便利店|买/.test(text)
        ? 'shopping'
        : /玩|休闲|娱乐/.test(text)
          ? 'leisure'
          : undefined;
  return {
    ...(query ? { query } : {}),
    ...(category ? { category } : {}),
    limit: 8,
  };
}

export function parseMapSearchDestinationInputFromText(text: string) {
  const destination = extractDestinationName(text) ?? text.trim();
  const category = hasAny(text, ['吃', '饭', '餐厅', '咖啡', '奶茶', '小吃', '夜宵', '美食'])
    ? 'food'
    : hasAny(text, ['商场', '超市', '便利店', '购物', '买'])
      ? 'shopping'
      : hasAny(text, ['玩', '休闲', '娱乐'])
        ? 'leisure'
        : hasAny(text, ['景点', '风景', '旅游', '好玩', '逛'])
          ? 'scenery'
          : undefined;
  const topic = category === 'food'
    ? '美食'
    : category === 'shopping'
      ? '购物'
      : category === 'leisure'
        ? '休闲'
        : '景点';
  return {
    destination,
    topic,
    ...(category ? { category } : {}),
    limit: 8,
  };
}

export function parseNearbyContextInputFromText(text: string) {
  return {
    allowRefresh: !/(?:只看缓存|不要刷新|别刷新)/.test(text),
    allowStale: /上次|缓存|旧/.test(text),
  };
}

export function parseLocationConsistencyInputFromText(text: string) {
  return {
    checkCurrent: !/(?:只看缓存|不要定位|别定位)/.test(text),
  };
}

function looksLikeDestinationSearch(text: string) {
  const destination = extractDestinationName(text);
  if (!destination) return false;
  if (isLikelyNonPlaceDestination(destination)) return false;
  if (!hasExplicitMapNavigationCue(text) && !looksLikeDestinationPlaceQuery(text)) return false;
  return !isLocalDestinationWord(destination);
}

function extractDestinationName(text: string) {
  const patterns = [
    /(?:导航到|定位到|目的地[:：]?|地图搜(?:索)?|查(?:一下)?去|搜(?:一下)?去|找(?:一下)?去)(.{1,24})(?:怎么走|怎么去|路线|附近|[，。！？\\n]|$)/,
    /(?:去|到)(.{1,24})(?:怎么走|怎么去|路线|导航)/,
    /(.{1,24})(?:有什么景点|有什么好玩的|有啥景点|哪里好玩|好玩吗)/,
    /(.{1,24})(?:有什么吃的|有什么美食|有什么餐厅|有什么店)/,
    /(.{1,24})附近有什么/,
  ];
  for (const pattern of patterns) {
    const raw = pattern.exec(text)?.[1]?.trim();
    if (!raw) continue;
    const cleaned = raw.replace(/^(想|想去|我要去|我想去|帮我看看|帮我查一下|帮我查查|帮我查|查一下|查查|查|看看|搜搜|搜索|查询|问问|这个|那个)/, '').replace(/[，。！？\s]+$/, '').trim();
    if (cleaned && !isLocalDestinationWord(cleaned) && !isLikelyNonPlaceDestination(cleaned)) return cleaned;
  }
  return undefined;
}

function hasExplicitMapNavigationCue(text: string) {
  return /(?:导航|路线|怎么走|怎么去|目的地|打开地图|地图搜|地图查|查路线|规划路线|带路|定位到)/.test(text);
}

function looksLikeDestinationPlaceQuery(text: string) {
  return /(?:有什么景点|有什么好玩的|有啥景点|哪里好玩|好玩吗|有什么吃的|有什么美食|有什么餐厅|有什么店|附近有什么)/.test(text);
}


function isLikelyNonPlaceDestination(value: string) {
  const normalized = value.replace(/\\s+/g, '');
  return /(?:bug|代码|正则|工具包?|功能|网课|课程|作业|启动|运行|执行|修一下|改一下|写一下|处理一下|厕所|洗手间|洗澡|睡觉|吃饭|喝水|上课|上班|下班|开会|回复|聊天|消息|小本本|prompt)/i.test(normalized);
}

function isLocalDestinationWord(value: string) {
  return ['我', '我家', '家', '这里', '这边', '我这里', '我这边', '附近', '周围', '旁边', '当前位置', '现在'].includes(value);
}

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

function extractNearbyQuery(text: string) {
  const match = text.match(/(?:附近|周围|旁边).{0,8}(?:有没有|有什么|找找|找一下|搜一下|查一下|看看)?\s*([^，。！？\n]{1,12})/);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;
  const cleaned = raw.replace(/^(的|有|什么|哪里|哪儿|可以|能|好|推荐)/, '').trim();
  return cleaned && !/^(东西|地点|地方|店)$/.test(cleaned) ? cleaned : undefined;
}

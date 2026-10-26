import {
  parseLocationConsistencyInputFromText,
  parseMapSearchDestinationInputFromText,
  parseMapSearchNearbyInputFromText,
  parseNearbyContextInputFromText,
  parseWeatherCurrentInputFromText,
  parseWeatherForecastInputFromText,
  routeWeatherMapNearbyIntent,
} from './weatherMapNearbyInputParsers';

export const WEATHER_MAP_NEARBY_AGENT_TOOL_IDS = [
  'weather.get_current',
  'weather.get_forecast',
  'map.reverse_geocode',
  'map.geocode_place',
  'map.search_destination',
  'map.search_nearby',
  'map.more_results',
  'nearby.describe_place_context',
  'nearby.verify_location_consistency',
] as const;

export type WeatherMapNearbyAgentToolId = typeof WEATHER_MAP_NEARBY_AGENT_TOOL_IDS[number];

export type WeatherMapNearbyLocationScope =
  | 'current'
  | 'explicit_place'
  | 'explicit_coordinates'
  | 'nearby_world';

export type WeatherMapNearbyIntentEvidence = {
  primaryToolId: WeatherMapNearbyAgentToolId;
  strength: 'strong' | 'possible';
  locationScope: WeatherMapNearbyLocationScope;
  deterministicInput: Record<string, unknown>;
  fallbackToolIds: WeatherMapNearbyAgentToolId[];
  requiresCurrentLocation: boolean;
};

const DOMAIN_SIGNAL_PATTERN =
  /天气|气温|温度|冷不冷|热不热|下雨|雨大吗|风大吗|附近|周围|旁边|地图|地址|坐标|经纬度|目的地|定位|位置|附近世界|餐厅|咖啡|奶茶|便利店|超市|公园|景点|商场/u;

const DIRECT_ACTION_PATTERN =
  /(?:^|[，,、\s])(?:帮我|请|麻烦|替我|给我|能不能|可以帮我|查一下|查查|查询|搜索|搜一下|看看|看一下|反查|解析|定位到|地图搜|地图查|导航到|你再帮我)|^(?:查|搜|搜索|查询|看看|反查|解析|把|将)/u;

const ABSOLUTE_PROTECTION_PATTERN =
  /(?:如果|假如|假设|会不会触发|为什么会触发|怎么会触发|调试|测试|正则|prompt|工具(?:包)?|翻译成|改写成|解释[“"'「『]|别人说|朋友说|同学说|他说|她说|别不|不要不|不是不).{0,60}(?:天气|附近|周围|旁边|地图|定位|地址|坐标)|(?:天气|附近|周围|旁边|地图|定位|地址|坐标).{0,60}(?:触发|调试|测试|正则|prompt|工具(?:包)?)/iu;

const REPORTED_PREFIX_PATTERN = /^(?:他|她|它|朋友|同学|同事|别人).{0,16}(?:说|问|提到|觉得)/u;
const IMPLICIT_NEARBY_PATTERN =
  /(?:这附近|附近|周围|旁边).{0,24}(?:有啥|有什么|有没有|哪里|哪家|能.{0,8}(?:坐|逛|吃|喝|玩).{0,8}(?:地方|店)?)/u;
const LOCAL_SCOPE_WORDS = new Set([
  '这里',
  '这边',
  '我这里',
  '我这边',
  '附近',
  '周围',
  '旁边',
  '当前位置',
  '现在',
  '今天',
  '明天',
  '后天',
  '未来',
  '这几天',
]);

export function isWeatherMapNearbyAgentToolId(
  toolId: string,
): toolId is WeatherMapNearbyAgentToolId {
  return (WEATHER_MAP_NEARBY_AGENT_TOOL_IDS as readonly string[]).includes(toolId);
}

export function analyzeWeatherMapNearbyIntent(
  text: string,
): WeatherMapNearbyIntentEvidence | undefined {
  const trimmed = text.trim();
  if (!trimmed || !DOMAIN_SIGNAL_PATTERN.test(trimmed)) return undefined;
  if (isAbsolutelyProtected(trimmed)) return undefined;

  const explicitCoordinates = extractCoordinates(trimmed);
  if (explicitCoordinates && /反查|经纬度.{0,12}(?:地址|哪里)|坐标.{0,12}(?:地址|哪里)/u.test(trimmed)) {
    return {
      primaryToolId: 'map.reverse_geocode',
      strength: 'strong',
      locationScope: 'explicit_coordinates',
      deterministicInput: explicitCoordinates,
      fallbackToolIds: [],
      requiresCurrentLocation: false,
    };
  }

  const actionableClause = findActionableClause(trimmed);
  if (!actionableClause) {
    return IMPLICIT_NEARBY_PATTERN.test(trimmed)
      ? {
          primaryToolId: 'map.search_nearby',
          strength: 'possible',
          locationScope: 'current',
          deterministicInput: parseMapSearchNearbyInputFromText(trimmed),
          fallbackToolIds: [],
          requiresCurrentLocation: true,
        }
      : undefined;
  }

  const coordinates = extractCoordinates(actionableClause);
  if (coordinates && /反查|地址|坐标|经纬度|什么地方|在哪里/u.test(actionableClause)) {
    return {
      primaryToolId: 'map.reverse_geocode',
      strength: 'strong',
      locationScope: 'explicit_coordinates',
      deterministicInput: coordinates,
      fallbackToolIds: [],
      requiresCurrentLocation: false,
    };
  }

  if (/定位|位置|附近世界|天气位置/u.test(actionableClause)
    && /准不准|漂|飘|偏|不对|冲突|一致/u.test(actionableClause)) {
    const deterministicInput = parseLocationConsistencyInputFromText(actionableClause);
    return {
      primaryToolId: 'nearby.verify_location_consistency',
      strength: 'strong',
      locationScope: 'nearby_world',
      deterministicInput,
      fallbackToolIds: [],
      requiresCurrentLocation: deterministicInput.checkCurrent !== false,
    };
  }

  if (/附近世界|周围环境|附近环境|附近参照|路边参照|附近状态/u.test(actionableClause)
    && !/设置|开启|关闭|后台|精度模式/u.test(actionableClause)) {
    return {
      primaryToolId: 'nearby.describe_place_context',
      strength: 'strong',
      locationScope: 'nearby_world',
      deterministicInput: parseNearbyContextInputFromText(actionableClause),
      fallbackToolIds: [],
      requiresCurrentLocation: true,
    };
  }

  const route = routeWeatherMapNearbyIntent(actionableClause);
  if (route?.candidateTools.includes('map.search_destination')) {
    return {
      primaryToolId: 'map.search_destination',
      strength: 'strong',
      locationScope: 'explicit_place',
      deterministicInput: parseMapSearchDestinationInputFromText(actionableClause),
      fallbackToolIds: [],
      requiresCurrentLocation: false,
    };
  }

  const geocodePlace = extractGeocodePlace(actionableClause);
  if (geocodePlace) {
    return {
      primaryToolId: 'map.geocode_place',
      strength: 'strong',
      locationScope: 'explicit_place',
      deterministicInput: { place: geocodePlace },
      fallbackToolIds: [],
      requiresCurrentLocation: false,
    };
  }

  if (route?.candidateTools.includes('map.search_nearby')) {
    return {
      primaryToolId: 'map.search_nearby',
      strength: 'strong',
      locationScope: 'current',
      deterministicInput: parseMapSearchNearbyInputFromText(actionableClause),
      fallbackToolIds: ['map.search_destination'],
      requiresCurrentLocation: true,
    };
  }

  const weatherToolId = route?.candidateTools.find((toolId) => (
    toolId === 'weather.get_current' || toolId === 'weather.get_forecast'
  ));
  if (weatherToolId) {
    const place = extractWeatherPlace(actionableClause);
    return {
      primaryToolId: weatherToolId,
      strength: 'strong',
      locationScope: place ? 'explicit_place' : 'current',
      deterministicInput: {
        ...(weatherToolId === 'weather.get_forecast'
          ? parseWeatherForecastInputFromText(actionableClause)
          : parseWeatherCurrentInputFromText(actionableClause)),
        ...(place ? { place } : {}),
      },
      fallbackToolIds: [],
      requiresCurrentLocation: !place,
    };
  }

  return undefined;
}

function findActionableClause(text: string) {
  const clauses = stripQuotedContent(text)
    .split(/[，,。！？!?；;\n]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return [...clauses].reverse().find((clause) => (
    DOMAIN_SIGNAL_PATTERN.test(clause)
    && !isAbsolutelyProtected(clause)
    && (DIRECT_ACTION_PATTERN.test(clause) || isDirectQuestionFragment(clause))
  ));
}

function isDirectQuestionFragment(clause: string) {
  return /^(?:我附近|我这边|我这里|这里|这附近|附近|周围).{0,24}(?:有什么|有没有|哪里|哪家|推荐)/u.test(clause)
    || /^[\p{Script=Han}A-Za-z0-9·]{2,20}(?:附近|周围).{0,20}(?:有什么|有啥|有没有|哪里|哪家|推荐)/u.test(clause)
    || /^(?:现在|当前|今天|明天|后天|外面)?(?:天气|气温|温度|冷不冷|热不热|会不会下雨|会下雨吗|下雨吗)/u.test(clause)
    || /^(?:[\p{Script=Han}A-Za-z0-9·]{2,20})(?:今天|明天|后天|未来|这几天|现在|当前)?(?:的)?(?:天气|气温|温度|会不会下雨|下雨吗)$/u.test(clause);
}

function isAbsolutelyProtected(text: string) {
  return ABSOLUTE_PROTECTION_PATTERN.test(text)
    || REPORTED_PREFIX_PATTERN.test(text)
    || /[“"'「『][^”"'」』]{0,120}(?:天气|附近|地图|定位|地址|坐标)[^”"'」』]{0,120}[”"'」』]/u.test(text);
}

function stripQuotedContent(text: string) {
  return text.replace(/[“"'「『][^”"'」』]*[”"'」』]/gu, ' ');
}

function extractCoordinates(text: string) {
  const match = /(-?\d{1,2}(?:\.\d+)?)\s*[,，\s]\s*(-?\d{1,3}(?:\.\d+)?)/u.exec(text);
  if (!match) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return undefined;
  return { latitude, longitude };
}

function extractGeocodePlace(text: string) {
  const patterns = [
    /(?:把|将)(.{1,24}?)(?:解析|查成|转成|换成).{0,8}(?:坐标|地址)/u,
    /(?:解析|查一下|查询)(.{1,24}?)(?:的)?(?:地址|坐标)/u,
  ];
  for (const pattern of patterns) {
    const value = cleanPlace(pattern.exec(text)?.[1]);
    if (value) return value;
  }
  return undefined;
}

export function extractWeatherPlace(text: string) {
  const normalized = text.trim();
  const patterns = [
    /^(?:帮我|请|麻烦|给我|替我|查(?:一下)?|查询|看看|看一下|搜(?:一下)?)?\s*([^，。！？\s]{2,20}?)(?:今天|明天|后天|未来|这几天)(?:会不会|会|要不要)?(?:下雨|有雨|天气|气温|温度)/u,
    /(?:查(?:一下)?|查询|看看|看一下|搜(?:一下)?)\s*([^，。！？\s]{2,20}?)(?:今天|明天|后天|未来|这几天|现在|当前)?(?:的)?(?:天气|气温|温度|会不会下雨|下雨吗)/u,
    /^([^，。！？\s]{2,20}?)(?:今天|明天|后天|未来|这几天|现在|当前)?(?:的)?(?:天气|气温|温度|会不会下雨|下雨吗)$/u,
  ];
  for (const pattern of patterns) {
    const value = cleanPlace(pattern.exec(normalized)?.[1]);
    if (value) return value;
  }
  return undefined;
}

function cleanPlace(value: string | undefined) {
  const cleaned = value
    ?.replace(/^(?:帮我查一下|帮我查|查一下|查询|查|帮我看看|看看|看一下|搜一下|帮我|请|麻烦|给我|替我|我想知道|我想查|一下)/u, '')
    .replace(/(?:今天|明天|后天|未来|这几天|现在|当前)$/u, '')
    .trim();
  if (!cleaned || LOCAL_SCOPE_WORDS.has(cleaned)) return undefined;
  if (/^(?:今天|明天|后天|未来|这几天)(?:会|会不会|要不要)?$/u.test(cleaned)) return undefined;
  if (/天气|气温|温度|下雨|附近|地图|工具|正则|prompt/iu.test(cleaned)) return undefined;
  return cleaned;
}

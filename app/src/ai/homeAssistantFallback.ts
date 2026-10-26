import type { WeatherKind } from '../types/weather';

export const HOME_ASSISTANT_FALLBACK_ROTATION_MS = 30 * 60_000;
export const HOME_ASSISTANT_HOT_TEMPERATURE_C = 30;

export type HomeAssistantFallbackDraft = Readonly<{
  activity: string;
  title: string;
}>;

export type HomeAssistantFallbackInput = Readonly<{
  lifeMode: 'available' | 'self-time' | 'sleeping';
  now: number;
  scheduleSlot?: string;
  sourceType?: string;
  updatedAt?: number;
  weather?: Readonly<{
    error?: string;
    isLoading?: boolean;
    kind: WeatherKind;
    temperature?: number;
  }>;
}>;

const pool = (...drafts: HomeAssistantFallbackDraft[]) => drafts;

export const HOME_ASSISTANT_FALLBACK_POOLS = Object.freeze({
  initial: pool(
    { title: '云云在这里呀', activity: '翅膀轻轻扑了两下，软乎乎地靠过来，先朝小仓鼠眨了眨眼睛。' },
    { title: '偷偷挪近一点', activity: '慢吞吞地飘到小仓鼠身边，装作自己本来就待在这里。' },
    { title: '把翅膀摆摆好', activity: '左边理一理，右边也理一理，端端正正地等小仓鼠看过来。' },
  ),
  general: pool(
    { title: '安静发一会儿呆', activity: '听着周围的声音，慢慢放空。' },
    { title: '今天飘得很稳', activity: '从房间这头慢慢飘到那头，中间没有碰歪任何东西，满意地扑了扑翅膀。' },
    { title: '给云朵拍拍松', activity: '轻轻抖开自己的边缘，再用翅膀拍一拍，整朵云都变得蓬蓬的。' },
    { title: '编了一小段旋律', activity: '轻轻哼完第一遍，又换了几个音，直到翅膀也跟着节拍晃起来。' },
    { title: '整理一小盒收藏', activity: '把喜欢的小东西一件件拿出来看过，再按照新的顺序认真放好。' },
    { title: '把一件小事做完啦', activity: '认真忙了一会儿，终于在纸上画下一个小勾，翅膀也跟着轻快地扬起来。' },
    { title: '描下翅膀的影子', activity: '翅膀的影子刚好落在纸上，便沿着边缘慢慢画了一圈。' },
  ),
  sleep: pool(
    { title: '安静睡着了', activity: '蓬松地摊成一片，边缘随着呼吸轻轻起伏。' },
    { title: '睡得圆滚滚', activity: '睡梦中翻了个身，把翅膀收进自己的云团里，又团成了圆滚滚的一朵。' },
    { title: '梦里扑了扑翅膀', activity: '翅膀在睡梦里轻轻扑了两下，云团跟着晃了晃，又安静下来。' },
    { title: '睡得香香的', activity: '慢吞吞地翻了个身，轻轻哼唧了一声' },
    { title: '梦里悄悄笑了', activity: '云团轻轻抖了一下，嘴角也跟着弯起来，不知道梦见了什么好事。' },
  ),
  wake: pool(
    { title: '还没完全醒', activity: '揉揉眼睛，翅膀还困倦地垂着，整朵云都慢半拍。' },
    { title: '醒来先找小仓鼠', activity: '刚把翅膀伸展开，就先看看小仓鼠有没有来过。' },
    { title: '整理睡乱的云团', activity: '把云团边缘一点点理好，再用翅膀拍拍还没散掉的困意。' },
  ),
  morning: pool(
    { title: '读到有趣的一页', activity: '翅膀压着刚翻开的书页，读到喜欢的地方，就在旁边画了一颗小星星。' },
    { title: '听一首喜欢的歌', activity: '跟着旋律轻轻晃着翅膀，听到熟悉的地方就偷偷哼两句。' },
    { title: '给翅膀梳梳毛', activity: '发现有一小撮羽毛睡得翘起来了，正低着头认真把它们理顺。' },
  ),
  noon: pool(
    { title: '午间歇一会儿', activity: '把刚才读过的东西先放下，靠在窗边安安静静地发一会儿呆。' },
    { title: '暂时不想飘', activity: '把自己摊在软垫上，安安静静地歇一小会儿。' },
    { title: '偷偷画小仓鼠', activity: '在纸角画了两只圆圆的耳朵，又认真添上一小颗鼻子。' },
  ),
  afternoon: pool(
    { title: '晒晒软乎乎的翅膀', activity: '把翅膀舒展开来，趴在窗边，看光影一点一点挪过去。' },
    { title: '偷偷换了个形状', activity: '把自己捏成圆滚滚的小仓鼠，对着玻璃瞧了瞧，又慢慢变回原来的样子。' },
    { title: '练习飘得低一点', activity: '贴着地板慢吞吞地飘了一圈，翅膀尖偶尔蹭到软垫，痒得自己偷偷笑。' },
  ),
  evening: pool(
    { title: '巡视自己的小领地', activity: '趁天还没完全黑，慢悠悠地飘过每个角落，确认喜欢的小东西都好好待着。' },
    { title: '给屋子换上暖黄色', activity: '打开一盏小灯，墙角和云朵边缘都变得暖融融的。' },
    { title: '把傍晚藏进云朵里', activity: '趴在窗边认真看了一会儿，等转过身时，云朵边缘也染上了一点暖暖的颜色。' },
  ),
  bedtime: pool(
    { title: '认真收好翅膀', activity: '先收起左边，再收起右边，钻进被窝后只露出一点软乎乎的云朵边缘。' },
    { title: '找一个最舒服的形状', activity: '在被窝里往左团一团，又往右团一团，终于满意地停下来。' },
    { title: '困意爬上云朵边缘', activity: '翅膀慢慢垂下来，眼睛也只肯睁开一条小缝，马上就要睡着了。' },
  ),
  sleepless: pool(
    { title: '暂时睡不着', activity: '把被角捏平，听夜里安静的声音。' },
    { title: '翻来覆去', activity: '把脸换了好几个方向，最后选中最软的那一边，决定再试着闭一会儿眼睛。' },
    { title: '还没有睡着', activity: '把翅膀轻轻搭在被子外面，盯着天花板看了一会儿，又慢吞吞地收回来。' },
  ),
});

export const HOME_ASSISTANT_AWAKE_WEATHER_POOLS = Object.freeze({
  rain: pool(
    { title: '趴着听一会儿雨', activity: '把翅膀松松搭在云团两边，听窗外的雨点一颗一颗落下来。' },
    { title: '给雨声伴奏', activity: '翅膀尖跟着滴答声轻轻打拍子，偶尔也哼上一小段。' },
    { title: '雨天飘得慢一点', activity: '空气里湿润润的，便放慢一点速度，舒舒服服地在屋里飘。' },
    { title: '追着一颗雨点看', activity: '从窗玻璃最上面一路看到最下面，等它滑不见了，才慢吞吞地眨一下眼睛。' },
    { title: '雨天的云朵更软啦', activity: '翅膀在湿润的空气里轻轻舒展开，连云朵边缘都变得软绵绵的。' },
  ),
  cloudy: pool(
    { title: '和天空里的云打个招呼', activity: '隔着窗户轻轻扑了扑翅膀，不知道远处哪一朵云最先看见。' },
    { title: '阴天也亮亮的', activity: '天色虽然灰灰的，白白的云团却显得格外亮，连边缘都软软发着光。' },
    { title: '跟着云层慢慢摊开', activity: '看着云层一点点铺满天空，自己也舒舒服服地摊成喜欢的形状。' },
    { title: '只有云云长了翅膀', activity: '认真看看窗外的云层，又低头看看自己的翅膀，忍不住悄悄得意了一下。' },
    { title: '替云层拍拍松', activity: '隔着窗户朝天空轻轻扑了几下翅膀，像是在帮厚厚的云层松一松边缘。' },
  ),
  clearDay: pool(
    { title: '晒得云朵暖乎乎', activity: '在阳光里待了一小会儿，白白的边缘都染上一层软软的金色。' },
    { title: '给翅膀晒晒两面', activity: '左边晒一会儿，右边也晒一会儿，直到每根羽毛都变得暖暖的。' },
    { title: '云朵边缘变透明啦', activity: '阳光从白白的边缘穿过去，低头一看，整朵云都泛着柔柔的光。' },
    { title: '在阳光里伸个懒腰', activity: '先把左边翅膀舒展开，再换右边，最后整朵云都变得蓬蓬的。' },
  ),
  clearHot: pool(
    { title: '云朵去乘凉啦', activity: '太阳晒得热热的，便飘到阴凉处，把翅膀松松垂下来，舒舒服服地歇一会儿。' },
  ),
  thunderstorm: pool(
    { title: '雷雨天的小堡垒', activity: '把软垫和被角围在身边，窝在最中间，听窗外轰隆隆地经过。' },
    { title: '闪电给云朵描了银边', activity: '亮光从窗边闪过，白白的云朵边缘一下变成银色，漂亮得忍不住多看两眼。' },
    { title: '雷雨天提前亮小灯', activity: '天色暗下来，便打开暖黄色的小灯，把自己的角落照得软乎乎的。' },
    { title: '在小堡垒里继续忙', activity: '把喜欢的小东西挪到软垫旁边，窝得舒舒服服，再接着做自己的事。' },
    { title: '小堡垒还能挤一只鼠', activity: '往软垫里面挪了挪，认真空出一小块位置，刚好够小仓鼠也躲进来。' },
  ),
  snow: pool(
    { title: '把云朵团得暖一点', activity: '看着窗外飘雪，便把翅膀收回自己的云团里，安安静静窝好。' },
    { title: '窗边来了一片雪花', activity: '贴在玻璃上停了一会儿，自己也凑近一点，和它隔着窗户安静对望。' },
    { title: '雪天的声音轻轻的', activity: '外面像被盖上一层软垫，便也放轻动作，慢吞吞地扑了两下翅膀。' },
    { title: '偶尔看看雪下到哪儿了', activity: '窝在窗边做自己的事，每次抬头，窗外就又悄悄白了一点。' },
    { title: '窗台上积了一小层雪', activity: '一片又一片安静叠起来，自己就在玻璃里面认真看着。' },
    { title: '窗边凉凉的', activity: '云朵边缘刚贴近玻璃就凉了一小块，便往暖和的地方挪回一点。' },
  ),
  hail: pool(
    { title: '小冰粒在敲窗户', activity: '噼里啪啦响了一阵，便停下手边的小事，认真听了听。' },
    { title: '今天留在屋里飘', activity: '窗外的小冰粒蹦来蹦去，自己就在安全的屋里慢悠悠绕一圈。' },
    { title: '看小冰珠弹起来', activity: '一颗落下去又跳得高高的，翅膀尖也忍不住跟着抬了一下。' },
  ),
  fog: pool(
    { title: '云云今天很会隐身', activity: '往窗边轻轻一靠，白白的云团就和外面的雾连成一片，只剩翅膀尖还露着。' },
    { title: '翅膀把云云出卖啦', activity: '明明已经藏在白雾一样的窗景里，两只翅膀却还在玻璃上留下清清楚楚的倒影。' },
    { title: '给雾画一扇小窗', activity: '玻璃蒙着薄薄的水汽，便用翅膀尖轻轻划开一小块，正好够看见外面。' },
    { title: '雾天的小窝更安静', activity: '窗外的声音像被盖上一层软垫，便窝好云团，专心做自己的小事。' },
    { title: '等雾自己让开', activity: '不着急往远处看，只把手边的小事慢慢做完，偶尔抬头瞧一眼。' },
  ),
  dust: pool(
    { title: '把窗户关得严严实实', activity: '检查完左边又检查右边，确认沙尘都留在外面，才放心扑扑翅膀。' },
    { title: '给翅膀挡挡灰', activity: '把两只翅膀收进自己的云团里，只露出一点点尖，等空气变干净。' },
    { title: '等风把沙尘带走', activity: '窝在安全的屋里做自己的事，隔一会儿看看窗外有没有变清楚。' },
    { title: '躲开窗边的风口', activity: '把云团和翅膀都挪远一点，一点灰也不肯沾。' },
    { title: '沙尘天的室内巡游', activity: '贴着屋里干净的地方慢慢飘一圈，再稳稳回到软垫旁边。' },
  ),
  clearNight: pool(
    { title: '偷偷连出一只小仓鼠', activity: '从最亮的一颗星开始慢慢连过去，连着连着，天空里就多了一只圆滚滚的小仓鼠。' },
    { title: '找到月亮旁边的位置', activity: '在窗边挑个正好能看见月亮的角落，稳稳待好，再继续做自己的小事。' },
    { title: '星光落到翅膀尖', activity: '玻璃上映着一点亮光，翅膀尖挪过去时，像悄悄接住了一颗小星星。' },
    { title: '待在两片夜空中间', activity: '窗外有一片，玻璃倒影里也有一片，云云刚好被亮晶晶的星星围在中间。' },
    { title: '云朵有两道亮亮的边', activity: '一层是屋里的暖光，一层是窗外的月色，安静叠在白白的边缘上。' },
  ),
});

export const HOME_ASSISTANT_SLEEP_WEATHER = Object.freeze({
  clear: { title: '月光盖在云朵上', activity: '睡着以后，白白的边缘被照得淡淡发亮，翅膀尖安静地藏在被窝里。' },
  cloudy: { title: '阴天睡得更软一点', activity: '窗外云层厚厚的，自己的云团也团得松松软软，安静窝着。' },
  rain: { title: '雨声守在窗外', activity: '雨点轻轻敲着玻璃，云团跟着均匀呼吸，一直没有醒。' },
  thunderstorm: { title: '雷声从梦外滚过去', activity: '窗外偶尔轰隆一声，翅膀在云团里轻轻动一下，又继续睡。' },
  snow: { title: '雪落得没有声音', activity: '窗外一片片变白，屋里的云朵也安安静静团在被窝里。' },
  hail: { title: '冰雹敲了一会儿窗', activity: '云团往被窝里缩深一点，把两只翅膀都好好收住。' },
  fog: { title: '雾把夜晚藏起来了', activity: '窗外白蒙蒙的，睡着的云朵只露出一点安静的边缘。' },
  dust: { title: '沙尘都留在窗外', activity: '窗户关得严严的，云团在干净的屋里蓬蓬地睡着。' },
} satisfies Partial<Record<WeatherKind, HomeAssistantFallbackDraft>>);

export const HOME_ASSISTANT_LATE_WAKE_WEATHER = Object.freeze({
  rain: pool({ title: '被雨声留住啦', activity: '听着雨声觉得被窝格外舒服，一时不太想起来。' }),
  cloudy: pool({ title: '阴天再团一会儿', activity: '天色阴阴的，很适合缩在云朵里再赖一会儿。' }),
});

type AwakeScene = 'wake' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'bedtime' | 'sleepless' | 'general';

function rotationStep(now: number) {
  return Math.floor((Number.isFinite(now) ? Math.max(0, now) : 0) / HOME_ASSISTANT_FALLBACK_ROTATION_MS);
}

function chooseLayered(layers: readonly (readonly HomeAssistantFallbackDraft[])[], now: number) {
  const available = layers.filter((layer) => layer.length > 0);
  const step = rotationStep(now);
  const layer = available[step % available.length];
  return layer[Math.floor(step / available.length) % layer.length];
}

function isNight(date: Date) {
  return date.getHours() < 6 || date.getHours() >= 18;
}

function sceneAt(input: HomeAssistantFallbackInput): AwakeScene {
  const slot = input.scheduleSlot ?? '';
  if (slot.includes(':early-morning:') || slot.endsWith(':morning-awake')) return 'wake';
  if (slot.includes(':morning:')) return 'morning';
  if (slot.includes(':noon:')) return 'noon';
  if (slot.includes(':afternoon:')) return 'afternoon';
  if (slot.includes(':evening:')) return 'evening';
  if (slot.includes(':bedtime:')) return input.lifeMode === 'self-time' ? 'sleepless' : 'bedtime';

  const date = new Date(input.now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes >= 6 * 60 && minutes < 9 * 60) return 'wake';
  if (minutes >= 9 * 60 && minutes < 11 * 60 + 30) return 'morning';
  if (minutes >= 11 * 60 + 30 && minutes < 14 * 60) return 'noon';
  if (minutes >= 14 * 60 && minutes < 18 * 60) return 'afternoon';
  if (minutes >= 18 * 60 && minutes < 21 * 60 + 30) return 'evening';
  if (minutes >= 21 * 60 + 30) return input.lifeMode === 'self-time' ? 'sleepless' : 'bedtime';
  return 'general';
}

function knownWeather(input: HomeAssistantFallbackInput) {
  const weather = input.weather;
  return weather && !weather.isLoading && weather.kind !== 'unknown' ? weather : undefined;
}

function awakeWeatherPool(input: HomeAssistantFallbackInput) {
  const weather = knownWeather(input);
  if (!weather) return [];
  const lateWake = input.scheduleSlot?.endsWith(':morning-awake');
  if (lateWake && weather.kind === 'rain') return HOME_ASSISTANT_LATE_WAKE_WEATHER.rain;
  if (lateWake && weather.kind === 'cloudy') return HOME_ASSISTANT_LATE_WAKE_WEATHER.cloudy;
  if (weather.kind === 'clear') {
    if (isNight(new Date(input.now))) return HOME_ASSISTANT_AWAKE_WEATHER_POOLS.clearNight;
    return typeof weather.temperature === 'number' && weather.temperature >= HOME_ASSISTANT_HOT_TEMPERATURE_C
      ? HOME_ASSISTANT_AWAKE_WEATHER_POOLS.clearHot
      : HOME_ASSISTANT_AWAKE_WEATHER_POOLS.clearDay;
  }
  return HOME_ASSISTANT_AWAKE_WEATHER_POOLS[weather.kind as keyof typeof HOME_ASSISTANT_AWAKE_WEATHER_POOLS] ?? [];
}

function sleepWeatherPool(input: HomeAssistantFallbackInput) {
  const weather = knownWeather(input);
  if (!weather || (weather.kind === 'clear' && !isNight(new Date(input.now)))) return [];
  const draft = HOME_ASSISTANT_SLEEP_WEATHER[weather.kind as keyof typeof HOME_ASSISTANT_SLEEP_WEATHER];
  return draft ? [draft] : [];
}

export function selectHomeAssistantFallback(input: HomeAssistantFallbackInput): HomeAssistantFallbackDraft {
  if (input.sourceType === 'default' && (input.updatedAt ?? 0) <= 0) {
    return chooseLayered([HOME_ASSISTANT_FALLBACK_POOLS.initial], input.now);
  }
  if (input.lifeMode === 'sleeping') {
    return chooseLayered([HOME_ASSISTANT_FALLBACK_POOLS.sleep, sleepWeatherPool(input)], input.now);
  }

  const scene = sceneAt(input);
  const hotClearAfternoon = scene === 'afternoon'
    && knownWeather(input)?.kind === 'clear'
    && (knownWeather(input)?.temperature ?? -Infinity) >= HOME_ASSISTANT_HOT_TEMPERATURE_C;
  const scenePool = scene === 'general'
    ? []
    : hotClearAfternoon
      ? HOME_ASSISTANT_FALLBACK_POOLS.afternoon.slice(1)
      : HOME_ASSISTANT_FALLBACK_POOLS[scene];
  const usesGeneral = scene === 'general' || scene === 'morning' || scene === 'noon'
    || scene === 'afternoon' || scene === 'evening';
  return chooseLayered([
    scenePool,
    awakeWeatherPool(input),
    usesGeneral ? HOME_ASSISTANT_FALLBACK_POOLS.general : [],
  ], input.now);
}

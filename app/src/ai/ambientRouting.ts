import type { AmbientContextCategory } from './ambientContext';

const WEATHER_CONTEXT_PATTERN = /天气|下雨|下雪|温度|冷不冷|热不热|出门|带伞/;
const LOCATION_CONTEXT_PATTERN = /位置|定位|哪里|哪儿|城市|地方|出门|附近|周边|周围|外面|在家|外出|吃什么|去哪/;
const SCHEDULE_CONTEXT_PATTERN = /日程|提醒|安排|行程|预约|会议|今天几点|明天几点|后天几点|什么时候开始/;
const TODO_CONTEXT_PATTERN = /待办|任务|清单|计划|今天.{0,8}(?:做|要做|该做)|明天.{0,8}(?:做|要做|该做)/;
const PHONE_ACTIVITY_CONTEXT_PATTERN = /手机活动|手机使用|使用时间|屏幕时间|玩手机|刷手机|刷了多久|用了什么应用|打开了什么应用|app|APP/;
const EXPLICIT_WEATHER_PATTERN = /天气(?:怎么样|如何|呢|吗)|会不会下|下雨了吗|多少度|温度多少|要不要带伞/;
const EXPLICIT_LOCATION_PATTERN = /我(?:在|的位置)|定位(?:到|是)|现在(?:在)?哪里|哪个城市|什么地方|附近(?:有什么|有啥|哪里|哪儿)|周边(?:有什么|有啥)|外面怎么样/;
const EXPLICIT_SCHEDULE_PATTERN = /有(?:什么|没有).{0,6}(?:日程|安排|行程|提醒)|日程是什么|几点|什么时候/;
const EXPLICIT_TODO_PATTERN = /有(?:什么|没有).{0,6}(?:待办|任务)|待办是什么|该做什么|要做什么/;
const EXPLICIT_PHONE_ACTIVITY_PATTERN = /手机.{0,8}(?:用了多久|使用情况|活动)|屏幕时间|打开了什么应用|用了什么应用/;

export type ChatAmbientRoute = {
  categories: AmbientContextCategory[];
  includeUnavailable: AmbientContextCategory[];
  wantsLocation: boolean;
  wantsPhoneActivity: boolean;
  wantsSchedule: boolean;
  wantsTodos: boolean;
  wantsWeather: boolean;
};

export function selectChatAmbientRoute(query: string): ChatAmbientRoute {
  const wantsWeather = WEATHER_CONTEXT_PATTERN.test(query);
  const wantsLocation = LOCATION_CONTEXT_PATTERN.test(query);
  const wantsSchedule = SCHEDULE_CONTEXT_PATTERN.test(query);
  const wantsTodos = TODO_CONTEXT_PATTERN.test(query);
  const wantsPhoneActivity = PHONE_ACTIVITY_CONTEXT_PATTERN.test(query);
  return {
    categories: [
      'time',
      ...(wantsWeather ? ['weather' as const] : []),
      ...(wantsLocation ? ['location' as const] : []),
      ...(wantsSchedule ? ['schedule' as const] : []),
      ...(wantsTodos ? ['todos' as const] : []),
      ...(wantsPhoneActivity ? ['phoneActivity' as const] : []),
    ],
    includeUnavailable: [
      ...(EXPLICIT_WEATHER_PATTERN.test(query) ? ['weather' as const] : []),
      ...(EXPLICIT_LOCATION_PATTERN.test(query) ? ['location' as const] : []),
      ...(EXPLICIT_SCHEDULE_PATTERN.test(query) ? ['schedule' as const] : []),
      ...(EXPLICIT_TODO_PATTERN.test(query) ? ['todos' as const] : []),
      ...(EXPLICIT_PHONE_ACTIVITY_PATTERN.test(query) ? ['phoneActivity' as const] : []),
    ],
    wantsLocation,
    wantsPhoneActivity,
    wantsSchedule,
    wantsTodos,
    wantsWeather,
  };
}

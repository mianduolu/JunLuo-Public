export type BodySignalIntentRoute = {
  candidateTools: Array<'body_signal.get_battery' | 'body_signal.get_latest' | 'body_signal.get_summary'>;
  reason: 'body_signal_battery' | 'body_signal_latest' | 'body_signal_summary';
};

const BODY_SIGNAL_NON_QUERY_PATTERN =
  /(?:我心慌|心慌|胸闷|痛经|肚子疼|不舒服|难受|心率模块|身体信号模块|蓝牙|BLE|bug|报错|协议|代码|开发|调试|测试页面)/i;
const BODY_SIGNAL_HYPOTHETICAL_PATTERN =
  /(?:如果|假设|要是|以后|未来|将来|能不能|会不会).{0,24}(?:心率|心跳|身体信号|戒指电量|戒指电池)/i;
const BODY_SIGNAL_SUMMARY_PATTERN =
  /(?:今天|今日).{0,12}(?:平均心率|心率平均|心率范围|最高心率|最低心率|心率最高|心率最低|测了几次|测量次数|心率趋势|心率摘要)/;
const BODY_SIGNAL_LATEST_PATTERN =
  /(?:(?:刚才|刚刚|最近(?:一次)?|上次).{0,10}(?:心率|心跳).{0,8}(?:多少|是多少|几|什么值|记录)|(?:我|我的).{0,4}(?:心率|心跳).{0,5}(?:多少|是多少|几)|(?:心率|心跳).{0,8}(?:刚才|刚刚|最近(?:一次)?|上次).{0,6}(?:多少|是多少|几|什么值))/;
const BODY_SIGNAL_BATTERY_PATTERN =
  /(?:(?:戒指|智能戒指|穿戴设备).{0,10}(?:电量|电池|还有多少电|该充电)|(?:电量|电池|还有多少电).{0,10}(?:戒指|智能戒指|穿戴设备))/;

export function routeBodySignalIntent(text: string): BodySignalIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (BODY_SIGNAL_NON_QUERY_PATTERN.test(trimmed) || BODY_SIGNAL_HYPOTHETICAL_PATTERN.test(trimmed)) {
    return null;
  }
  if (BODY_SIGNAL_BATTERY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['body_signal.get_battery'],
      reason: 'body_signal_battery',
    };
  }
  if (BODY_SIGNAL_SUMMARY_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['body_signal.get_summary'],
      reason: 'body_signal_summary',
    };
  }
  if (BODY_SIGNAL_LATEST_PATTERN.test(trimmed)) {
    return {
      candidateTools: ['body_signal.get_latest'],
      reason: 'body_signal_latest',
    };
  }
  return null;
}

import type {
  BodySignalCapabilityEvidence,
  BodySignalProtocolReference,
} from './bodySignalCapabilityLedger';

const R99_HEART_RATE_FIXTURE = 'sha256:5d0490a8365a655f7880f50d66c940884513ed0946769d6f62ae4d3cdac93224';
const R99_BATTERY_FIXTURE = 'sha256:7cbead040401b6bbaff4bb6ba54fda0af9c94d667eec94dbb39cf5610fec99e9';
const STANDARD_GATT_FIXTURE = 'sha256:5db40e6b75f7c955d8f1cd5b546c4240999b284d22736f628073d82793fa28b6';
const MI_BAND_6_AUTH_FIXTURE = 'sha256:4c9ec7fdae0aada490933ca397369fd0e4aa93528d5f5f9b70222bc3030c65c1';
const MI_BAND_6_REALTIME_FIXTURE = 'sha256:8055447022f6d4e746d5c0d023c31a5dba1c2d4eef118c4208f4b330fd4a2b71';

export const GADGETBRIDGE_PROTOCOL_REFERENCE: BodySignalProtocolReference = {
  id: 'gadgetbridge-0a067d7313d0',
  repository: 'https://codeberg.org/Freeyourgadget/Gadgetbridge.git',
  commit: '0a067d7313d0c597f04523593b0c31f18642959a',
  commitDate: '2026-08-02T22:32:50+02:00',
  localPath: 'cankao/戒指和手环/Gadgetbridge-0a067d7313d0',
  sourceRanges: [
    'app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/huami/zeppos/services/ZeppOsHeartRateService.java:36-47',
    'app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/huami/zeppos/services/ZeppOsHeartRateService.java:112-142',
    'app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/huami/zeppos/services/ZeppOsHeartRateService.java:182-182',
    'app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/huami/zeppos/services/ZeppOsServicesService.java:32-87',
    'app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/huami/Huami2021ChunkedEncoder.java:45-129',
  ],
  notes: '固定提交仅用于协议交叉验证；君落运行时不依赖 Gadgetbridge 源码、数据库或进程。',
};

const r99HeartRateEvidence = [
  'fixture:r99-heart-rate:scripts/body-signal-smarthealth-r99-eval.ts',
  'true-device:r99:2026-07-08-smarthealth-heart-rate',
  'regression:npm:body-signal-smarthealth-r99:eval',
] as const;

const miBand6StandardHeartRateEvidence = [
  'fixture:standard-gatt-heart-rate:scripts/body-signal-standard-gatt-eval.ts',
  'true-device:mi-band-6:2026-07-23-standard-heart-rate',
  'regression:npm:body-signal-standard-gatt:eval',
] as const;

const miBand6AuthEvidence = [
  'fixture:mi-band-6-auth:scripts/body-signal-mi-band-6-auth-eval.ts',
  'true-device:mi-band-6:2026-07-24-huami-2021-auth',
  'regression:npm:body-signal-mi-band-6-auth:eval',
] as const;

const miBand6RealtimeEvidence = [
  'fixture:mi-band-6-realtime:scripts/body-signal-mi-band-6-realtime-eval.ts',
  'true-device:mi-band-6:2026-07-28-five-minute-heart-rate',
  'regression:npm:body-signal-mi-band-6-realtime:eval',
] as const;

function awaiting(deviceFamily: string, capability: string, notes: string): BodySignalCapabilityEvidence {
  return {
    id: `${deviceFamily}.${capability}`,
    deviceFamily,
    capability,
    status: 'awaiting_fixture',
    evidenceIds: [],
    fixtureHashes: [],
    verifiedDeviceCount: 0,
    verifiedReconnectCount: 0,
    notes,
  };
}

function forbidden(capability: string, notes: string): BodySignalCapabilityEvidence {
  const evidenceId = `policy:default-deny:${capability}`;
  return {
    id: `all_devices.${capability}`,
    deviceFamily: 'all_devices',
    capability,
    status: 'forbidden',
    evidenceIds: [evidenceId],
    fixtureHashes: [],
    verifiedDeviceCount: 0,
    verifiedReconnectCount: 0,
    writeEvidence: [{
      purpose: capability,
      target: 'all BLE transports',
      evidenceId,
      authorization: 'forbidden',
    }],
    notes,
  };
}

export const BODY_SIGNAL_CAPABILITY_LEDGER: readonly BodySignalCapabilityEvidence[] = [
  {
    id: 'smarthealth_r99.realtime_heart_rate',
    deviceFamily: 'smarthealth_r99',
    capability: 'realtime_heart_rate',
    status: 'verified',
    evidenceIds: r99HeartRateEvidence,
    fixtureHashes: [R99_HEART_RATE_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 1,
    writeEvidence: [{
      purpose: 'smarthealth_r99_heart_rate',
      target: 'verified SmartHealth R99 be94 channel',
      evidenceId: r99HeartRateEvidence[0],
      authorization: 'verified',
    }],
    notes: 'R99 心率请求、回包解析、断开重连和历史落库均已由当前真机验证。',
  },
  {
    id: 'smarthealth_r99.battery',
    deviceFamily: 'smarthealth_r99',
    capability: 'battery',
    status: 'awaiting_fixture',
    evidenceIds: [
      'fixture:r99-battery-100:scripts/body-signal-smarthealth-r99-battery-eval.ts',
      'true-device:r99:2026-07-22-battery-100-only',
      'regression:npm:body-signal-smarthealth-r99-battery:eval',
    ],
    fixtureHashes: [R99_BATTERY_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 1,
    writeEvidence: [{
      purpose: 'smarthealth_r99_battery',
      target: 'verified SmartHealth R99 be94 diagnostic path',
      evidenceId: 'fixture:r99-battery-100:scripts/body-signal-smarthealth-r99-battery-eval.ts',
      authorization: 'diagnostic_only',
    }],
    notes: '目前只有 100% 一份真实 fixture；取得第二个不同百分比前不得授权后台或自动读取。',
  },
  awaiting('smarthealth_r99', 'activity_history', '尚无同一 R99 设备的真实活动历史抓包。'),
  awaiting('smarthealth_r99', 'sleep_history', '尚无同一 R99 设备的真实睡眠抓包。'),
  awaiting('smarthealth_r99', 'spo2', '尚无同一 R99 设备的真实血氧抓包。'),
  awaiting('smarthealth_r99', 'stress', '尚无同一 R99 设备的真实压力抓包。'),
  awaiting('smarthealth_r99', 'hrv', '尚无同一 R99 设备的真实 HRV 抓包。'),
  {
    id: 'mi_band_6.authentication',
    deviceFamily: 'mi_band_6',
    capability: 'authentication',
    status: 'verified',
    evidenceIds: miBand6AuthEvidence,
    fixtureHashes: [MI_BAND_6_AUTH_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 1,
    notes: 'Huami 2021 认证已由 Mi Smart Band 6 真机与固定向量验证；会话密钥只存在内存。',
  },
  {
    id: 'mi_band_6.realtime_heart_rate',
    deviceFamily: 'mi_band_6',
    capability: 'realtime_heart_rate',
    status: 'verified',
    evidenceIds: miBand6StandardHeartRateEvidence,
    fixtureHashes: [STANDARD_GATT_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 1,
    notes: '认证后从标准 180D/2A37 接收心率，解析、持久化和重连均已真机验证。',
  },
  {
    id: 'mi_band_6.continuous_heart_rate_control',
    deviceFamily: 'mi_band_6',
    capability: 'continuous_heart_rate_control',
    status: 'verified',
    evidenceIds: miBand6RealtimeEvidence,
    fixtureHashes: [MI_BAND_6_REALTIME_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 3,
    writeEvidence: [
      'start_manual',
      'stop_manual',
      'start_continuous',
      'stop_continuous',
    ].map((purpose) => ({
      purpose,
      target: 'Mi Band 6 standard heart-rate control point 180D/2A39',
      evidenceId: miBand6RealtimeEvidence[0],
      authorization: 'verified' as const,
    })),
    notes: '四条完整 2A39 控制包和五分钟生命周期已通过真机矩阵；不得扩展任意写入。',
  },
  {
    id: 'mi_band_6.battery', deviceFamily: 'mi_band_6', capability: 'battery', status: 'verified',
    evidenceIds: [
      'fixture:mi-band-6-battery:android/app/src/test/resources/mi-band-6-battery-device-fixtures.tsv',
      'true-device:mi-band-6:2026-09-16-battery-8-unplugged-10-charging',
      'true-device:mi-band-6:2026-09-16-reconnect-read-user-confirmed',
      'regression:npm:body-signal-mi-band-6-battery:eval',
    ],
    fixtureHashes: ['sha256:8be5e15777b1c0a4955398879ac1d66d05abee5eb68ed0951c309ef13014b7e4'],
    verifiedDeviceCount: 1, verifiedReconnectCount: 1,
    notes: '同设备真实前缀 0f 08 00 / 0f 0a 01，用户核对百分比与充电状态并确认重连可读；只授权 FEE0/0006 READ，不解释首字节或尾部，不授权写包。正式保存与展示仍待新版真机验收。',
  },
  {
    id: 'mi_band_6.activity_history', deviceFamily: 'mi_band_6', capability: 'activity_history', status: 'verified',
    evidenceIds: [
      'fixture:mi-band-6-activity:scripts/fixtures/mi-band-6-activity-real-stream.json',
      'true-device:mi-band-6:2026-09-18-complete-stream-7648-minutes',
      'true-device:mi-band-6:2026-09-18-native-and-legacy-heart-rate-preemption',
      'regression:npm:body-signal-mi-band-6-activity:eval',
    ],
    fixtureHashes: ['sha256:43b4d86813f5ae095d5e1557342bf6d78c8670d45a29642889c19f549314578d'],
    verifiedDeviceCount: 1, verifiedReconnectCount: 1,
    writeEvidence: [{
      purpose: 'mi_band_6_activity_history', target: 'Mi Band 6 FEE0/0004 START(01 01 + time) and FETCH(02) only',
      evidenceId: 'fixture:mi-band-6-activity:scripts/fixtures/mi-band-6-activity-real-stream.json', authorization: 'verified',
    }],
    notes: '完整通知流及双语言逐分钟对照通过；同连接重复读取保留历史、重连与两种 owner 心率优先通过。只采用分钟步数及强度，不发送最终设备 ACK。正式落库、后台补录与短保留清理待新版真机收口；序号回绕只有合成回归，不冒充真机证据。',
  },
  awaiting('mi_band_6', 'sleep_history', '27B 已接主要睡眠时长的只读保存路径，待部署验收；通用睡眠情境与阶段能力未开放。'),
  awaiting('mi_band_6', 'spo2', '尚未建立 Mi Band 6 血氧请求与回包真实 fixture。'),
  awaiting('mi_band_6', 'stress', '尚未明确 Mi Band 6 压力字段含义并完成真机验证。'),
  awaiting('mi_band_6', 'hrv', '尚未明确 Mi Band 6 HRV 数据含义并完成真机验证。'),
  {
    id: 'standard_gatt_heart_rate.realtime_heart_rate',
    deviceFamily: 'standard_gatt_heart_rate',
    capability: 'realtime_heart_rate',
    status: 'verified',
    evidenceIds: miBand6StandardHeartRateEvidence,
    fixtureHashes: [STANDARD_GATT_FIXTURE],
    verifiedDeviceCount: 1,
    verifiedReconnectCount: 1,
    notes: '可复用读取能力仅在设备真实暴露可通知或指示的 180D/2A37 时成立；本条不授权写入。',
  },
  {
    id: 'standard_colmi_reference.set_time',
    deviceFamily: 'standard_colmi_reference',
    capability: 'set_time',
    status: 'reference_only',
    evidenceIds: ['reference:colmi-rxx:set-time-packet'],
    fixtureHashes: [],
    verifiedDeviceCount: 0,
    verifiedReconnectCount: 0,
    notes: '只有标准 COLMI 参考实现；未在当前 R99 或 Mi Band 6 上验证，不得据此发包。',
  },
  {
    id: 'standard_colmi_reference.battery',
    deviceFamily: 'standard_colmi_reference',
    capability: 'battery',
    status: 'reference_only',
    evidenceIds: ['reference:colmi-rxx:battery-packet'],
    fixtureHashes: [],
    verifiedDeviceCount: 0,
    verifiedReconnectCount: 0,
    notes: '标准 COLMI 0x03 不能套给 R99 或 Mi Band 6；只保留为未来标准设备研究索引。',
  },
  ...['spo2', 'stress', 'hrv', 'sleep_history'].map((capability) => ({
    id: `standard_colmi_reference.${capability}`,
    deviceFamily: 'standard_colmi_reference',
    capability,
    status: 'reference_only' as const,
    evidenceIds: [`reference:colmi-rxx:${capability}`],
    fixtureHashes: [],
    verifiedDeviceCount: 0,
    verifiedReconnectCount: 0,
    notes: '参考项目含 assumed 或 experimental 路径，只能研究，不能进入普通 UI、后台任务或安全白名单。',
  })),
  forbidden('arbitrary_ble_write', '任何未登记 purpose、任意 hex 或裸 bytes 写入一律拒绝。'),
  forbidden('reboot', '普通 UI、后台同步与 Provider 均不得重启穿戴设备。'),
  forbidden('factory_reset', '恢复出厂设置是破坏性操作，不进入君落身体感知能力。'),
  forbidden('bind', '未经单独证据与交互设计，不开放设备绑定控制。'),
  forbidden('raw_sensor_stream', 'raw PPG/加速度流停止机制与功耗边界未验证，禁止自动或普通 UI 使用。'),
];

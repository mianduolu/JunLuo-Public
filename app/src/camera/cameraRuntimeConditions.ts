/** Live native conditions; not a persisted preference or standby authorization. */
export type CameraRuntimeConditions = {
  batteryPercent: number | null;
  charging: boolean | null;
  thermalStatus: number | null;
  lowBatteryPaused: boolean;
  thermalPaused: boolean;
  powerSaveMode: boolean | null;
  batteryOptimizationExempt: boolean | null;
  backgroundRestricted: boolean | null;
  cameraPrivacyToggleSupported: boolean | null;
  checkedAt: number;
  simulated: boolean;
};

export function parseCameraRuntimeConditions(value: unknown): CameraRuntimeConditions | undefined {
  if (value === undefined) return undefined; // Older APKs do not provide this extension.
  const fail = () => { throw new Error('camera_invalid_bridge_payload'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const source = value as Record<string, unknown>;
  const nullableBoolean = (field: string): boolean | null => {
    const candidate = source[field];
    if (candidate === null) return null;
    return typeof candidate === 'boolean' ? candidate : fail();
  };
  const boolean = (field: string): boolean => typeof source[field] === 'boolean'
    ? source[field] as boolean : fail();
  const nullableInteger = (field: string, maximum: number): number | null => {
    const candidate = source[field];
    if (candidate === null) return null;
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate <= maximum
      ? candidate : fail();
  };
  const checkedAt = source.checkedAt;
  if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt < 0) return fail();
  return {
    batteryPercent: nullableInteger('batteryPercent', 100),
    charging: nullableBoolean('charging'),
    thermalStatus: nullableInteger('thermalStatus', 6),
    lowBatteryPaused: boolean('lowBatteryPaused'),
    thermalPaused: boolean('thermalPaused'),
    powerSaveMode: nullableBoolean('powerSaveMode'),
    batteryOptimizationExempt: nullableBoolean('batteryOptimizationExempt'),
    backgroundRestricted: nullableBoolean('backgroundRestricted'),
    cameraPrivacyToggleSupported: nullableBoolean('cameraPrivacyToggleSupported'),
    checkedAt,
    simulated: boolean('simulated'),
  };
}

export function cameraCaptureConditionFailure(
  conditions: CameraRuntimeConditions | undefined,
  kind: 'model' | 'manual' | 'preview',
): string | undefined {
  // Native owns battery hysteresis and confirmed pauses when a later reading is unknown.
  if (conditions?.thermalPaused) return 'camera_thermal_paused';
  if (kind === 'model' && conditions?.lowBatteryPaused) return 'camera_low_battery';
  return undefined;
}

export function describeCameraCaptureConditionFailure(failureCode?: string): string {
  if (failureCode === 'camera_thermal_paused') return '系统严重温控：暂停新拍摄与预览；已取得画面继续按原流程收尾。';
  if (failureCode === 'camera_low_battery') return '低电量：模型新拍摄暂停，手动看一眼与预览仍可使用。';
  return failureCode ?? '未发现电量／温控拍摄限制';
}

export function describeCameraRuntimeConditions(conditions?: CameraRuntimeConditions) {
  const flag = (value: boolean | null | undefined, yes: string, no: string) => value === true
    ? yes : value === false ? no : '未知／未上报';
  const thermalStatus = conditions?.thermalStatus;
  const thermal = thermalStatus === 0 ? '系统暂无严重上报（不代表温控传感完整）'
    : thermalStatus === 1 ? '系统轻度温控'
      : thermalStatus === 2 ? '系统中度温控'
        : thermalStatus === 3 ? '系统严重温控'
          : thermalStatus === 4 ? '系统危急温控'
            : thermalStatus === 5 ? '系统紧急温控'
              : thermalStatus === 6 ? '系统报告关机级温控' : '未知／未上报';
  const batteryPercent = conditions?.batteryPercent;
  return {
    battery: `${batteryPercent == null ? '电量未知' : `${batteryPercent}%`} · ${flag(conditions?.charging, '充电中', '未充电')}`,
    thermal,
    powerSave: flag(conditions?.powerSaveMode, '已开启', '未开启'),
    optimization: flag(conditions?.batteryOptimizationExempt, '已获优化豁免', '仍受系统电池优化'),
    background: flag(conditions?.backgroundRestricted, '系统报告受限', '系统未报告受限（不包含全部红米限制）'),
    cameraPrivacy: flag(conditions?.cameraPrivacyToggleSupported, '系统支持；当前开关需手动核对', '系统未报告支持；当前开关状态未知'),
    source: conditions ? (conditions.simulated ? 'Debug 限制模拟＋原生读数' : '原生系统读数') : '尚未取得原生条件／旧 APK 未提供',
  };
}

const LOCATION_REQUEST_PATTERN =
  /(?:定位|当前位置|当前地点|现在位置|位置在哪|我在哪|我在哪里|我在哪儿|经纬度|坐标|GPS|gps)|(?:看|读|查|获取).{0,8}(?:位置|定位|经纬度|坐标)/;

const NEARBY_WORLD_STATUS_PATTERN =
  /(?:附近世界|附近缓存|定位缓存|附近定位).{0,12}(?:状态|缓存|位置|坐标|漂移|偏了|准不准)/;

export function looksLikeLocationRequest(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return LOCATION_REQUEST_PATTERN.test(trimmed);
}

export function looksLikeNearbyWorldStatusRequest(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return NEARBY_WORLD_STATUS_PATTERN.test(trimmed);
}

export function parseLocationToolInputFromText(text: string) {
  if (!looksLikeLocationRequest(text)) return null;
  const wantsBalanced = /粗略|大概|省电|低精度/.test(text);
  return {
    accuracy: wantsBalanced ? 'balanced' : 'high',
    reverseGeocode: true,
  };
}

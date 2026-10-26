/* WGS84 → GCJ-02, adapted from https://github.com/wandergis/coordtransform
 * The MIT License (MIT)
 * Copyright (c) 2015 记忆的残骸
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type AmapCoordinateSystem = 'wgs84' | 'gcj02';
export type MapCoordinate = { latitude: number; longitude: number };

export function isValidMapCoordinate(point: MapCoordinate): boolean {
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

export function toAmapCoordinate(point: MapCoordinate, source: AmapCoordinateSystem): MapCoordinate {
  if (!isValidMapCoordinate(point)) throw new Error('Invalid map coordinate');
  if (source === 'gcj02') return { ...point };
  if (source !== 'wgs84') throw new Error('Unknown coordinate system');
  const { latitude: lat, longitude: lng } = point;
  // Keep the upstream algorithm's coverage bounds; this is not a geographic claim.
  if (!(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55)) return { ...point };
  const x = lng - 105;
  const y = lat - 35;
  const pi = Math.PI;
  let dlat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dlat += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  dlat += (20 * Math.sin(y * pi) + 40 * Math.sin(y / 3 * pi)) * 2 / 3;
  dlat += (160 * Math.sin(y / 12 * pi) + 320 * Math.sin(y * pi / 30)) * 2 / 3;
  let dlng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dlng += (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  dlng += (20 * Math.sin(x * pi) + 40 * Math.sin(x / 3 * pi)) * 2 / 3;
  dlng += (150 * Math.sin(x / 12 * pi) + 300 * Math.sin(x / 30 * pi)) * 2 / 3;
  const radlat = lat / 180 * pi;
  const magic = 1 - 0.00669342162296594323 * Math.sin(radlat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  dlat = dlat * 180 / ((6378245 * (1 - 0.00669342162296594323)) / (magic * sqrtMagic) * pi);
  dlng = dlng * 180 / (6378245 / sqrtMagic * Math.cos(radlat) * pi);
  return { latitude: lat + dlat, longitude: lng + dlng };
}

export function mapDistanceMeters(left: MapCoordinate, right: MapCoordinate): number {
  const radians = Math.PI / 180;
  const a = Math.sin((right.latitude - left.latitude) * radians / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians)
    * Math.sin((right.longitude - left.longitude) * radians / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

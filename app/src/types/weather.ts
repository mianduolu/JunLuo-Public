export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'thunderstorm' | 'snow' | 'hail' | 'fog' | 'dust' | 'unknown';

export type WeatherObservationSource =
  | 'open-meteo'
  | 'wttr'
  | 'legacy-normalized';

export type WeatherState = {
  kind: WeatherKind;
  label: string;
  placeLabel?: string;
  temperature?: number;
  source?: WeatherObservationSource;
  observedAt?: number;
  isLoading: boolean;
  error?: string;
};

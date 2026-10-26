export type VoiceCallLiveKitUrlOptions = Readonly<{
  includeUsbLoopbackFallback?: boolean;
}>;

function isLoopbackHost(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function normalizeLiveKitUrl(url: string) {
  return url.replace(/\/$/, '');
}

function pushUniqueUrl(urls: string[], url: string) {
  const normalized = normalizeLiveKitUrl(url);
  if (normalized && !urls.includes(normalized)) urls.push(normalized);
}

export function buildLiveKitUrlCandidates(
  livekitUrl: string,
  backendBaseUrl: string,
  options: VoiceCallLiveKitUrlOptions = {},
) {
  const urls: string[] = [];
  const usbLoopbackUrl = 'ws://127.0.0.1:7880';

  try {
    const livekit = new URL(livekitUrl);
    const backend = new URL(backendBaseUrl);
    const backendIsLoopback = isLoopbackHost(backend.hostname);
    const livekitIsLoopback = isLoopbackHost(livekit.hostname);

    if (options.includeUsbLoopbackFallback) {
      pushUniqueUrl(urls, usbLoopbackUrl);
    }

    if (livekitIsLoopback && !backendIsLoopback) {
      livekit.hostname = backend.hostname;
      livekit.port = '7880';
      pushUniqueUrl(urls, livekit.toString());
    } else {
      pushUniqueUrl(urls, livekitUrl);
    }
    if (options.includeUsbLoopbackFallback) pushUniqueUrl(urls, usbLoopbackUrl);
  } catch {
    pushUniqueUrl(urls, livekitUrl);
    if (options.includeUsbLoopbackFallback) pushUniqueUrl(urls, usbLoopbackUrl);
  }

  return urls;
}

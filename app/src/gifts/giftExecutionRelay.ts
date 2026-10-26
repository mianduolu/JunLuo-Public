import { loadBackendSettings } from '../backend/backendClient';

export async function loadGiftExecutionRelayBaseUrl(): Promise<string> {
  return (await loadBackendSettings()).baseUrl.trim();
}

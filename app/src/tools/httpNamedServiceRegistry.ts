import { fetchBackendStatus, loadBackendSettings, testBackendConnection } from '../backend/backendClient';

export type JunLuoHttpNamedServiceResult = {
  ok: boolean;
  status?: number | string;
  summary: string;
  data?: unknown;
};

export type JunLuoHttpNamedService = {
  id: string;
  name: string;
  description: string;
  allowedMethods: string[];
  baseUrlDescription: string;
  execute: (input: Record<string, unknown>) => Promise<JunLuoHttpNamedServiceResult>;
};

const services = new Map<string, JunLuoHttpNamedService>();

export function registerHttpNamedService(service: JunLuoHttpNamedService) {
  const id = service.id.trim();
  if (!id) throw new Error('HTTP named service id is required');
  if (services.has(id)) throw new Error(`Duplicate HTTP named service id: ${id}`);
  services.set(id, { ...service, id });
}

export function unregisterHttpNamedService(serviceId: string) {
  services.delete(serviceId.trim());
}

export function listHttpNamedServices() {
  return Array.from(services.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export function getHttpNamedService(serviceId: string) {
  return services.get(serviceId.trim());
}

export function clearHttpNamedServicesForTests() {
  services.clear();
}

function hasService(serviceId: string) {
  return services.has(serviceId);
}

export function ensureBuiltinHttpNamedServices() {
  if (!hasService('junluo_backend.health')) {
    registerHttpNamedService({
      id: 'junluo_backend.health',
      name: '君落后端健康检查',
      description: '检查设置页里保存的君落后端 /health 是否连得上。',
      allowedMethods: ['GET'],
      baseUrlDescription: '使用君落后端设置里的 baseUrl',
      execute: async () => {
        const settings = await loadBackendSettings();
        const result = await testBackendConnection(settings.baseUrl);
        return {
          ok: result.ok,
          summary: result.detail,
          data: {
            backendEnabled: settings.enabled,
            baseUrlConfigured: Boolean(settings.baseUrl.trim()),
            detail: result.detail,
          },
        };
      },
    });
  }

  if (!hasService('junluo_backend.status')) {
    registerHttpNamedService({
      id: 'junluo_backend.status',
      name: '君落后端状态',
      description: '读取君落后端 /api/status 的运行状态摘要。',
      allowedMethods: ['GET'],
      baseUrlDescription: '使用君落后端设置里的 baseUrl',
      execute: async () => {
        const settings = await loadBackendSettings();
        const status = await fetchBackendStatus(settings.baseUrl);
        if (!status) {
          return {
            ok: false,
            summary: settings.baseUrl.trim()
              ? '没有读取到君落后端状态'
              : '还没有配置君落后端地址',
            data: {
              backendEnabled: settings.enabled,
              baseUrlConfigured: Boolean(settings.baseUrl.trim()),
            },
          };
        }
        return {
          ok: true,
          summary: `君落后端状态：${status.status}`,
          data: status,
        };
      },
    });
  }
}

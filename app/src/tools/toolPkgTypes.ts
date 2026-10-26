import type { JunLuoToolHookType } from './toolHookTypes';
import type { JunLuoToolPermissionLevel, JunLuoToolRiskLevel, JunLuoToolSource } from './toolTypes';

export type JunLuoToolPkgSource = Extract<JunLuoToolSource, 'mcp' | 'local_plugin'>;

export type JunLuoToolPkgHookDeclaration = {
  hookType: JunLuoToolHookType;
  id: string;
  description?: string;
  enabled?: boolean;
};

export type JunLuoToolPkgPermissionDeclaration = {
  riskLevel: JunLuoToolRiskLevel;
  defaultPermission: JunLuoToolPermissionLevel;
  reason?: string;
};

export type JunLuoToolPkgManifest = {
  id: string;
  name: string;
  version: string;
  source: JunLuoToolPkgSource;
  description?: string;
  packageIds?: string[];
  permissions?: JunLuoToolPkgPermissionDeclaration[];
  hooks?: JunLuoToolPkgHookDeclaration[];
};

export type JunLuoToolPkgRegistration = {
  manifest: JunLuoToolPkgManifest;
  registeredPackageIds: string[];
  hookDeclarations: JunLuoToolPkgHookDeclaration[];
  createdAt: number;
};

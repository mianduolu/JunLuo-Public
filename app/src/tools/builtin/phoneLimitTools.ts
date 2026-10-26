import { PHONE_LIMIT_PACKAGE_ID, PHONE_LIMIT_PACKAGE_NAME, PHONE_LIMIT_PACKAGE_DESCRIPTION,
  PHONE_LIMIT_TOOL_METADATA } from '../phoneLimitContract';
import { phoneLimitPreExecutionResult } from '../phoneLimitModelResult';
import type { JunLuoToolPackage } from '../toolTypes';

export const phoneLimitToolPackage: JunLuoToolPackage = {
  id: PHONE_LIMIT_PACKAGE_ID, name: PHONE_LIMIT_PACKAGE_NAME, description: PHONE_LIMIT_PACKAGE_DESCRIPTION,
  category: 'device', source: 'builtin', defaultEnabled: true, riskLevel: 'write_local',
  tools: PHONE_LIMIT_TOOL_METADATA.map(metadata => ({ ...metadata,
    permission: 'allow', riskLevel: metadata.id === 'phone_limit.get_status' ? 'read' : 'write_local',
    readOnly: metadata.id === 'phone_limit.get_status', chatExposure: 'candidate', proactiveEligible: true,
    conflictGroup: PHONE_LIMIT_PACKAGE_ID, executionScope: 'local_device',
    agentEpochMode: metadata.id === 'phone_limit.get_status' ? 'read_only_outside_lease' : 'bounded_local_commits',
    backupRestoreSafeOutsideLease: true,
    executor: (call, context) => {
      if ((call.requestedBy === 'chat' || call.requestedBy === 'proactive') && context?.phoneLimit) return context.phoneLimit(call);
      const now = Date.now();
      return phoneLimitPreExecutionResult({ callId: call.callId, toolId: call.toolId, ok: false,
        status: 'permission_denied', summary: '', startedAt: now, finishedAt: now });
    },
  })),
};

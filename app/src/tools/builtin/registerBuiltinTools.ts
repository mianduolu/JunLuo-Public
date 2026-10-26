import { getToolDefinition, registerToolPackage } from '../toolRegistry';
import { browserToolPackage } from './browserTools';
import { bodySignalToolPackage } from './bodySignalTools';
import { communicationToolPackage } from './communicationTools';
import { credentialToolPackage } from './credentialTools';
import { developerLabToolPackage } from './developerLabTools';
import { deviceToolPackage } from './deviceTools';
import { expenseToolPackage } from './expenseTools';
import { filesToolPackage } from './fileTools';
import { githubToolPackage } from './githubTools';
import { httpToolPackage } from './httpTools';
import { locationToolPackage } from './locationTools';
import { imageToolPackage, mediaToolPackage, videoToolPackage } from './mediaImageTools';
import { mcpAdminToolPackage } from './mcpAdminTools';
import { memoryToolPackage } from './memoryTools';
import { musicToolPackage } from './musicTools';
import { phoneContextToolPackage } from './phoneContextTools';
import { researchToolPackage } from './researchTools';
import { alarmToolPackage, reminderToolPackage } from './reminderAlarmAgentTools';
import { scheduleToolPackage } from './scheduleTools';
import { systemStatusToolPackage } from './systemStatusTools';
import { systemToolPackage } from './systemTools';
import { todoToolPackage } from './todoTools';
import { voiceToolPackage } from './voiceTools';
import { mapToolPackage, nearbyToolPackage, weatherToolPackage } from './weatherMapNearbyTools';
import { workflowToolPackage } from './workflowTools';
import { sleepScheduleToolPackage } from './lifeSleepTools';
import { cameraObservationToolPackage } from './cameraObservationTools';
import { proactiveContactToolPackage } from './proactiveContactTools';
import { readingToolPackage } from './readingTools';
import { wishToolPackage } from './wishTools';
import { giftToolPackage } from './giftTools';
import { phoneLimitToolPackage } from './phoneLimitTools';

export function registerBuiltinTools() {
  [
    systemToolPackage,
    sleepScheduleToolPackage,
    readingToolPackage,
    wishToolPackage,
    giftToolPackage,
    cameraObservationToolPackage,
    proactiveContactToolPackage,
    todoToolPackage,
    scheduleToolPackage,
    expenseToolPackage,
    memoryToolPackage,
    credentialToolPackage,
    systemStatusToolPackage,
    bodySignalToolPackage,
    weatherToolPackage,
    mapToolPackage,
    nearbyToolPackage,
    locationToolPackage,
    phoneContextToolPackage,
    phoneLimitToolPackage,
    filesToolPackage,
    communicationToolPackage,
    workflowToolPackage,
    githubToolPackage,
    mediaToolPackage,
    imageToolPackage,
    videoToolPackage,
    reminderToolPackage,
    alarmToolPackage,
    browserToolPackage,
    httpToolPackage,
    mcpAdminToolPackage,
    developerLabToolPackage,
    researchToolPackage,
    deviceToolPackage,
    musicToolPackage,
    voiceToolPackage,
  ].forEach((toolPackage) => {
    if (toolPackage.tools.every((tool) => getToolDefinition(tool.id))) return;
    registerToolPackage(toolPackage);
  });
}



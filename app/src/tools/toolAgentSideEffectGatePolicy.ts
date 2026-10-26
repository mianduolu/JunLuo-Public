export const MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID = 'music.playback_intent';
export const CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID = 'camera.current_standby';
export const SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID = 'life.sleep_chat_window';
export const CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID = 'proactive_contact.current_chat';
export const READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID = 'reading.current_activity';
export const OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID = 'schedule.current_conversation';
export const WISH_SIDE_EFFECT_GATE_POLICY_ID = 'wish.current_conversation';
export const GIFT_SIDE_EFFECT_GATE_POLICY_ID = 'gift.current_conversation';
export const MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID = 'map.current_query';
export const BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID = 'browser.current_chat';
export const APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID = 'device.current_chat_launch';
export const DIALER_SIDE_EFFECT_GATE_POLICY_ID = 'communication.current_chat_dialer';
export const TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID = 'files.current_chat';
export const CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID = 'image.current_chat';
export const CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID = 'schedule.you_current_conversation';
export const PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID = 'phone_limit.saved_scope';
export const MAP_QUERY_STATE_TOOL_IDS = new Set(['map.search_nearby', 'map.search_destination', 'map.more_results',
  'map.reverse_geocode', 'map.geocode_place', 'nearby.describe_place_context']);

const REGISTERED_SIDE_EFFECT_GATE_POLICY_IDS = new Set<string>([
  DIALER_SIDE_EFFECT_GATE_POLICY_ID,
  APP_LAUNCH_SIDE_EFFECT_GATE_POLICY_ID,
  CHAT_IMAGE_SIDE_EFFECT_GATE_POLICY_ID,
  CHAT_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID,
  PHONE_LIMIT_SIDE_EFFECT_GATE_POLICY_ID,
  TEXT_FILE_CHAT_SIDE_EFFECT_GATE_POLICY_ID,
  MUSIC_PLAYBACK_INTENT_SIDE_EFFECT_GATE_POLICY_ID,
  CAMERA_STANDBY_SIDE_EFFECT_GATE_POLICY_ID,
  SLEEP_CHAT_WINDOW_SIDE_EFFECT_GATE_POLICY_ID,
  CONTACT_CHAT_SIDE_EFFECT_GATE_POLICY_ID,
  READING_ACTIVITY_SIDE_EFFECT_GATE_POLICY_ID,
  OWN_SCHEDULE_SIDE_EFFECT_GATE_POLICY_ID,
  WISH_SIDE_EFFECT_GATE_POLICY_ID,
  GIFT_SIDE_EFFECT_GATE_POLICY_ID,
  MAP_QUERY_SIDE_EFFECT_GATE_POLICY_ID,
  BROWSER_OPEN_SIDE_EFFECT_GATE_POLICY_ID,
]);

export function isRegisteredToolAgentSideEffectGatePolicy(policyId: string | undefined) {
  return !!policyId && REGISTERED_SIDE_EFFECT_GATE_POLICY_IDS.has(policyId);
}

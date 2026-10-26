import type { RelationshipPhase } from './junluoInnerState';

export type JunluoAutomaticRelationshipOutlet =
  | 'autonomous_call'
  | 'ordinary_proactive'
  | 'phone_jealousy';

const ENDED_ROMANTIC_DRIVES = new Set([
  'attachment',
  'libido',
  'miss_you',
  'be_chosen',
  'affection_with_you',
  'desire_you',
]);

export function isJunluoAutomaticRelationshipOutletAllowed(input: {
  driveKey?: string | null;
  outlet: JunluoAutomaticRelationshipOutlet;
  phase: RelationshipPhase;
}) {
  if (input.outlet === 'phone_jealousy') {
    return input.phase !== 'ended' && input.phase !== 'rebuilding';
  }

  if (input.outlet === 'autonomous_call') {
    if (input.phase === 'ended') return false;
    if (input.phase === 'rebuilding') {
      return input.driveKey !== 'libido'
        && input.driveKey !== 'be_chosen'
        && input.driveKey !== 'affection_with_you'
        && input.driveKey !== 'desire_you';
    }
    return true;
  }

  if (input.phase === 'ended') {
    return !input.driveKey || !ENDED_ROMANTIC_DRIVES.has(input.driveKey);
  }
  if (input.phase === 'rebuilding') {
    return input.driveKey !== 'libido'
      && input.driveKey !== 'be_chosen'
      && input.driveKey !== 'affection_with_you'
      && input.driveKey !== 'desire_you';
  }
  return true;
}

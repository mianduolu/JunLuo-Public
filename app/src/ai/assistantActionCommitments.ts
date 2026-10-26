export type AssistantActionCommitmentKind = 'notebook';

export type AssistantActionCommitment = {
  kind: AssistantActionCommitmentKind;
  phrase: string;
};

const NOTEBOOK_COMMITMENT_PATTERN =
  /(?:写|记|放|收|存|留).{0,8}(?:小本本|小纸条|本本)|(?:小本本|小纸条|本本).{0,10}(?:写|记|放|收|存|留|用上|用起来)|(?:我会|以后会|之后会).{0,8}(?:用|记得用).{0,6}(?:小本本|小纸条|本本)/;

export function detectAssistantActionCommitments(contents: string[]): AssistantActionCommitment[] {
  const text = contents.join('\n');
  const commitments: AssistantActionCommitment[] = [];
  const match = text.match(NOTEBOOK_COMMITMENT_PATTERN);
  if (match?.[0]) {
    commitments.push({ kind: 'notebook', phrase: match[0] });
  }
  return commitments;
}

export function hasNotebookCommitment(contents: string[]) {
  return detectAssistantActionCommitments(contents).some((commitment) => commitment.kind === 'notebook');
}

export function buildNotebookCommitmentFallback(resultSummary: string) {
  return resultSummary || '这轮小本本没有落成，我会改口，不把它说成完成。';
}


import type { TheaterBranch, TheaterCheckpoint, TheaterStory, TheaterTextVersion } from './theaterStoryTypes';
import type { TheaterAdoption } from './theaterStoryTypes';
import { theaterCheckpointCoverage } from './theaterSummaryStore';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';

export const THEATER_CREATION_BUDGET = 2000;
export type TheaterCoCreationSelection = {
  revision: string;
  checkpointParagraphs: number[];
  lines: { versionId: string; start: number; end: number }[];
  updatedAt: number;
  attempts?: { wants: number; affect: number };
};
export type TheaterCoCreationSource = {
  storyId: string; branchId: string; title: string; branchName: string;
  positionId: string; at: number; opening: boolean;
  names?: { I: string; you: string };
  identities?: { I: string; you: string };
  messages: { versionId: string; subject: 'I' | 'you'; content: string }[];
  checkpoint?: { id: string; content: string };
};
export type TheaterCoCreationSnapshot = {
  story: TheaterStory;
  versions: TheaterTextVersion[];
  branches: { branch: TheaterBranch; adoptions: TheaterAdoption[]; checkpoints: TheaterCheckpoint[] }[];
};

/** Completed actions and quoted dialogue are distinct: editing an I line never creates an action. */
export function theaterCoCreationSources(snapshot: TheaterCoCreationSnapshot): TheaterCoCreationSource[] {
  const versions = new Map(snapshot.versions.map(v => [v.id, v]));
  const origins = snapshot.versions.filter(v => v.kind === 'dialogue' && v.subject === 'I'
    && v.origin === 'generated' && v.coCreation).sort((a, b) => a.coCreation!.completedAt - b.coCreation!.completedAt);
  const result: TheaterCoCreationSource[] = [];
  const seen = new Set<string>();
  for (const origin of origins) {
    if (seen.has(origin.positionId)) continue;
    const creation = origin.coCreation!;
    const branches = [...snapshot.branches].sort((a, b) =>
      Number(b.branch.id === creation.branchId) - Number(a.branch.id === creation.branchId)
      || a.branch.createdAt - b.branch.createdAt || a.branch.id.localeCompare(b.branch.id));
    const opening = creation.youVersionIds.length === 0;
    const alternatives = branches.flatMap(row => {
      const end = row.adoptions.findIndex(a => a.positionId === origin.positionId);
      if (end < 0) return [];
      const adopted = row.adoptions.map(a => versions.get(a.versionId));
      if (adopted.some((v, index) => !v || v.positionId !== row.adoptions[index].positionId)) return [];
      const current = adopted[end]!, group: TheaterTextVersion[] = [];
      for (let index = end - 1; index >= 0; index--) {
        const version = adopted[index]!;
        if (version.kind !== 'dialogue') continue;
        if (version.subject !== 'you') break;
        group.unshift(version);
      }
      const matches = creation.youVersionIds.length === group.length
        && group.every((v, index) => v.id === creation.youVersionIds[index]);
      return [{ row, end, adopted, current, group, quote: matches && (!opening || adopted.slice(0, end).every(v => v?.kind !== 'dialogue'))
        && current.kind === 'dialogue' && current.subject === 'I' && current.origin === 'generated' }];
    });
    const usable = alternatives.find(item => item.quote) ?? alternatives[0];
    if (!usable) continue;
    const { row, end, adopted, current, group, quote } = usable;
    const selected = quote ? [...group, current] : [];
    const checkpoint = row.checkpoints.find(c => c.id === row.branch.activeCheckpointId);
    const coverage = checkpoint ? theaterCheckpointCoverage({ story: snapshot.story, branch: row.branch,
      adoptions: row.adoptions, versions: adopted as TheaterTextVersion[], checkpoint }, checkpoint) : null;
    // A later summary cannot tell an earlier batch its future, nor turn covered lines into new action.
    const firstNew = group.length ? row.adoptions.findIndex(a => a.versionId === group[0].id) : end;
    const preceding = coverage !== null && coverage < firstNew;
    result.push({ storyId: snapshot.story.id, branchId: row.branch.id, title: snapshot.story.title,
      branchName: row.branch.name, positionId: origin.positionId, at: creation.completedAt, opening,
      names: snapshot.story.settings.names,
      ...(creation.identities ? { identities: creation.identities } : {}),
      messages: selected.flatMap(v => v.kind === 'dialogue'
        ? [{ versionId: v.id, subject: v.subject, content: v.content }] : []),
      ...(preceding && checkpoint ? { checkpoint: { id: checkpoint.id, content: checkpoint.content } } : {}) });
    seen.add(origin.positionId);
  }
  return result.sort((a, b) => a.at - b.at || a.positionId.localeCompare(b.positionId));
}

export function theaterCoCreationRevision(source: TheaterCoCreationSource) {
  // Rename, navigation and appended future dialogue do not invalidate a selected excerpt.
  return innerMaterialKey([source.storyId, source.branchId, source.positionId, source.at, source.identities ?? null,
    source.messages, source.checkpoint ?? null]);
}
export function theaterCheckpointParagraphs(source: TheaterCoCreationSource) {
  return source.checkpoint?.content.split(/\r?\n\s*\r?\n/).filter(s => s.trim()) ?? [];
}
/** Exact original substrings; UI selection never asks a model to rewrite dialogue. */
export function theaterCoCreationSentences(source: TheaterCoCreationSource) {
  return source.messages.flatMap(message => {
    const pieces = message.content.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/g) ?? [];
    let offset = 0;
    return pieces.map(content => {
      const start = offset; offset += content.length;
      return { versionId: message.versionId, subject: message.subject, content, start, end: offset };
    }).filter(piece => piece.content.trim());
  });
}
export function fullTheaterCoCreationSelection(source: TheaterCoCreationSource, now: number): TheaterCoCreationSelection {
  return { revision: theaterCoCreationRevision(source), updatedAt: now,
    checkpointParagraphs: theaterCheckpointParagraphs(source).map((_, index) => index),
    lines: theaterCoCreationSentences(source).map(({ versionId, start, end }) => ({ versionId, start, end })) };
}
function selectionParts(source: TheaterCoCreationSource, selection?: TheaterCoCreationSelection) {
  if (selection && selection.revision !== theaterCoCreationRevision(source)) return null;
  const paragraphs = theaterCheckpointParagraphs(source);
  if (selection && (new Set(selection.checkpointParagraphs).size !== selection.checkpointParagraphs.length
    || selection.checkpointParagraphs.some((index, ordinal, all) => !Number.isInteger(index) || index < 0
      || index >= paragraphs.length || ordinal > 0 && index <= all[ordinal - 1]))) return null;
  const sentences = theaterCoCreationSentences(source);
  const indexes = selection?.lines.map(line => sentences.findIndex(s => s.versionId === line.versionId
    && s.start === line.start && s.end === line.end));
  if (indexes && indexes.some((index, ordinal) => index < 0 || ordinal > 0 && index <= indexes[ordinal - 1])) return null;
  const chosen = indexes ? indexes.map(index => sentences[index]) : sentences;
  const messages = source.messages.flatMap(message => {
    const parts = chosen.filter(line => line.versionId === message.versionId);
    if (!parts.length) return [];
    if (parts.length === sentences.filter(line => line.versionId === message.versionId).length) return [`${message.subject}：${message.content}`];
    // Keep disjoint sentences separate instead of joining them into an invented contiguous quote.
    const runs: string[] = []; let lastEnd = -1;
    for (const part of parts) {
      if (part.start === lastEnd) runs[runs.length - 1] += part.content;
      else runs.push(part.content);
      lastEnd = part.end;
    }
    return runs.map(content => `${message.subject}：${content}`);
  });
  return { checkpoint: selection && selection.checkpointParagraphs.length !== paragraphs.length ? selection.checkpointParagraphs.map(index => paragraphs[index]).join('\n\n')
    : source.checkpoint?.content ?? '', messages,
    checkpointExcerpt: !!selection && selection.checkpointParagraphs.length !== paragraphs.length,
    linesExcerpt: !!indexes && indexes.length !== sentences.length };
}
export function renderTheaterCoCreationMaterial(source: TheaterCoCreationSource, selection?: TheaterCoCreationSelection, allowEmpty = false) {
  const parts = selectionParts(source, selection);
  if (!parts || !allowEmpty && !parts.messages.length) return null;
  return ['【一起写的故事】', '这是 I 与 you 共同创作的虚构剧情。演绎这一段时，I 心里有什么变化呢？',
    '小抄记着故事的前情，新台词是这次一起续写的部分。', '',
    `创作时间：${formatChatAfterglowMessageTime(source.at)}`, `来源：${source.title}／${source.branchName}`,
    ...(source.identities ? [`戏内身份：I＝${source.identities.I}；you＝${source.identities.you}`] : []),
    ...(parts.checkpoint ? ['', parts.checkpointExcerpt ? '【前情小抄（节选）】' : '【前情小抄】', parts.checkpoint] : []),
    '', parts.linesExcerpt ? '【本次新台词（节选）】' : '【本次新台词】', ...parts.messages].join('\n');
}
export const theaterMaterialLength = (material: string) => Array.from(material).length;
export function renderLatestTheaterCoCreationFact(sources: TheaterCoCreationSource[], now: number) {
  const source = sources.filter(s => s.at <= now && now - s.at < 24 * 60 * 60_000)
    .sort((a, b) => b.at - a.at || a.positionId.localeCompare(b.positionId))[0];
  if (!source) return '';
  const at = formatChatAfterglowMessageTime(source.at);
  return `【一起写故事】\n${source.opening
    ? `${at}，you 发起了小剧场《${source.title}》的「${source.branchName}」，I 写下了故事的开场。`
    : `${at}，I 与 you 在小剧场《${source.title}》的「${source.branchName}」里，一起续写了故事。`}`;
}

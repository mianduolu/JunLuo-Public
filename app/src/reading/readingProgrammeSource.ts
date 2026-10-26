import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeEpubEntities, epubAttributes } from './epubContent';

export const NASA_PROGRAMME_CATALOG = 'https://www.nasa.gov/podcasts/curious-universe/';
export type ProgrammeEpisode = {
  id: string; title: string; series: string; sourceName: string; sourceUrl: string;
  language: string; durationMs?: number;
};
export type ProgrammeCue = { paragraphIndex: number; startMs: number; endMs: number };
export type ProgrammeFetcher = (url: string, options?: { redirect: 'error' | 'follow' }) => Promise<{
  ok: boolean; status?: number; url?: string; text(): Promise<string>;
}>;
export type ProgrammeTranscript = {
  text: string; paragraphs: string[]; cues: ProgrammeCue[]; format: 'srt' | 'vtt' | 'html';
  durationMs?: number; language: string; sourceUrl: string;
};

function textContent(html: string) {
  return decodeEpubEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\r/g, '').trim();
}

function nasaUrl(value: string, base = NASA_PROGRAMME_CATALOG) {
  const url = new URL(decodeEpubEntities(value), base);
  if (url.protocol !== 'https:' || !['www.nasa.gov', 'nasa.gov', 'svs.gsfc.nasa.gov'].includes(url.hostname)
    || url.username || url.password || url.port) throw new Error('programme-source-not-supported');
  if (url.hostname === 'nasa.gov') url.hostname = 'www.nasa.gov';
  url.hash = '';
  return url;
}

function episodeUrl(value: string) {
  const url = nasaUrl(value);
  if (url.hostname !== 'www.nasa.gov' || !/^\/podcasts\/curious-universe\/[^/]+\/?$/.test(url.pathname)
    || /^\/podcasts\/curious-universe\/page\/?$/.test(url.pathname)) throw new Error('programme-source-not-supported');
  url.search = '';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/`;
  return url.toString();
}

export function programmeDownloadSupported(value: string) {
  try { episodeUrl(new URL(value).toString()); return true; } catch { return false; }
}

/** Manual cards keep their real source; this does not grant the downloader access. */
export function canonicalProgrammeSource(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('programme-source-invalid');
  }
  if (programmeDownloadSupported(value)) return episodeUrl(value);
  url.hash = '';
  return url.toString();
}

async function download(url: string, fetcher: ProgrammeFetcher) {
  const approved = nasaUrl(url).toString();
  if (/\.(?:mp4|mp3|mov|wav|m4a|webm)(?:\?|$)/i.test(approved)) throw new Error('programme-media-download-not-supported');
  const response = await fetcher(approved, { redirect: 'error' });
  if (!response.ok) throw new Error(`programme-download-http-${response.status ?? 'unknown'}`);
  if (response.url) nasaUrl(response.url);
  return response.text();
}

function anchors(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(match => ({
    attributes: epubAttributes(match[1]), text: textContent(match[2]), index: match.index!, end: match.index! + match[0].length,
  }));
}

function titleKey(title: string) { return title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function duration(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  return match ? duration((Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000) : undefined;
}

// Only the selected episode's associated object may supply an untimed duration.
// A trailer's duration elsewhere on the page cannot make a full transcript ready.
function episodeDuration(html: string, title: string) {
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root: unknown;
    try { root = JSON.parse(match[1]); } catch { continue; }
    const visit = (value: unknown): number | undefined => {
      if (Array.isArray(value)) { for (const item of value) { const result = visit(item); if (result) return result; } return; }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.name === 'string' && titleKey(record.name) === titleKey(title)) {
        const direct = duration(record.duration);
        if (direct) return direct;
        const media = record.associatedMedia;
        if (media && typeof media === 'object' && !Array.isArray(media)) return duration((media as Record<string, unknown>).duration);
      }
      return visit(record['@graph']);
    };
    const found = visit(root);
    if (found) return found;
  }
  return undefined;
}

export async function fetchProgrammeCatalog(page: number | string, fetcher: ProgrammeFetcher): Promise<{
  episodes: ProgrammeEpisode[]; nextPage?: string;
}> {
  if (typeof page === 'number' && page !== 1) throw new Error('programme-page-reference-required');
  const url = nasaUrl(page === 1 ? NASA_PROGRAMME_CATALOG : String(page));
  if (url.hostname !== 'www.nasa.gov' || !/^\/podcasts\/curious-universe\/(?:page\/\d+\/?)?$/.test(url.pathname)) {
    throw new Error('programme-source-not-supported');
  }
  const html = await download(url.toString(), fetcher);
  const episodes = new Map<string, ProgrammeEpisode>();
  let nextPage: string | undefined;
  for (const anchor of anchors(html)) {
    const href = anchor.attributes.href;
    if (!href) continue;
    if (/\bnext\b/i.test(`${anchor.attributes.rel ?? ''} ${anchor.attributes.class ?? ''}`)
      || /^(?:next|next page|下一页)(?:\s*[›»→])?$/i.test(anchor.text)) {
      try {
        const next = nasaUrl(href, url.toString());
        if (next.hostname === 'www.nasa.gov' && /^\/podcasts\/curious-universe\/(?:page\/\d+\/?)?$/.test(next.pathname)
          && next.toString() !== url.toString()) nextPage = next.toString();
      } catch { /* An unrelated navigation link is not this programme's cursor. */ }
      continue;
    }
    if (!anchor.text || /^(?:read more|listen|listen now|learn more)$/i.test(anchor.text)) continue;
    let sourceUrl: string;
    try { sourceUrl = episodeUrl(new URL(href, url).toString()); } catch { continue; }
    if (episodes.has(sourceUrl)) continue;
    episodes.set(sourceUrl, {
      id: `programme-${bytesToHex(sha256(new TextEncoder().encode(sourceUrl)))}`,
      title: anchor.text, series: 'Curious Universe', sourceName: 'NASA', sourceUrl,
      language: 'en', durationMs: episodeDuration(html, anchor.text),
    });
  }
  if (!episodes.size) throw new Error('programme-catalog-empty-or-unrecognized');
  return { episodes: [...episodes.values()], ...(nextPage ? { nextPage } : {}) };
}

function cueTime(value: string) {
  const match = value.match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('programme-caption-time-invalid');
  return (Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]);
}

function cueText(value: string) {
  return textContent(value.replace(/<v(?:\.[\w-]+)*\s+([^>]+)>/gi, (_match, speaker: string) => `\n${textContent(speaker)}: `)
    .replace(/<\d{2}:\d{2}(?::\d{2})?\.\d{3}>/g, '')).replace(/\n{2,}/g, '\n');
}

export function parseProgrammeCaptions(text: string, format: 'srt' | 'vtt'): {
  paragraphs: string[]; cues: ProgrammeCue[]; language?: string;
} {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (format === 'vtt' && !/^WEBVTT(?:\s|$)/.test(normalized)) throw new Error('programme-caption-header-invalid');
  const paragraphs: string[] = [], cues: ProgrammeCue[] = [];
  let language: string | undefined;
  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    if (format === 'vtt' && /^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) {
      if (/^WEBVTT(?:\s|$)/.test(lines[0]) && block.includes('-->')) throw new Error('programme-caption-header-invalid');
      language ??= block.match(/^Language:\s*([^\s]+)\s*$/im)?.[1];
      continue;
    }
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex < 0 || timingIndex > 1 || !lines.slice(timingIndex + 1).join('').trim()) throw new Error('programme-caption-block-invalid');
    const timing = lines[timingIndex].match(/^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/);
    if (!timing) throw new Error('programme-caption-time-invalid');
    const startMs = cueTime(timing[1]), endMs = cueTime(timing[2]);
    if (endMs <= startMs || (cues.length > 0 && startMs < cues[cues.length - 1].startMs)) throw new Error('programme-caption-time-invalid');
    const paragraph = cueText(lines.slice(timingIndex + 1).join('\n'));
    if (!paragraph) throw new Error('programme-caption-block-invalid');
    cues.push({ paragraphIndex: paragraphs.length, startMs, endMs });
    paragraphs.push(paragraph);
  }
  if (!cues.length) throw new Error('programme-caption-empty');
  return { paragraphs, cues, ...(language ? { language } : {}) };
}

function headingContext(html: string, at: number) {
  const stack: Array<{ level: number; text: string }> = [];
  for (const heading of html.slice(0, at).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(heading[1]);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: textContent(heading[2]) });
  }
  return stack.map(item => item.text);
}

function fullEpisodeLink(html: string, anchor: ReturnType<typeof anchors>[number], episode: ProgrammeEpisode) {
  const context = [...headingContext(html, anchor.index), anchor.text, anchor.attributes.title ?? ''];
  if (context.some(text => /\b(?:trailer|teaser|preview|excerpt|clip|promo|highlights)\b/i.test(text))) return false;
  return context.some(text => /\b(?:full|complete)\s+(?:episode|transcript|programme|program)\b/i.test(text)
    || titleKey(text) === titleKey(episode.title));
}

// Current NASA episode pages put the transcript in this bounded container,
// without a Transcript heading. Do not treat the whole page as episode text.
function nasaPodcastBody(html: string): string | undefined {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const divs = [...clean.matchAll(/<\/?div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)];
  const starts = divs.filter(match => !/^<\//.test(match[0])
    && (epubAttributes(match[0].slice(4, -1)).class ?? '').split(/\s+/).includes('hds-podcast-content'));
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  let depth = 0;
  for (const tag of divs.filter(match => match.index! >= start.index!)) {
    depth += /^<\//.test(tag[0]) ? -1 : 1;
    if (depth === 0) {
      let body = clean.slice(start.index! + start[0].length, tag.index);
      // The current template prefixes two p elements (label + description).
      const prefix = body.match(/^\s*<p\b[^>]*>([\s\S]*?)<\/p>\s*<p\b[^>]*>[\s\S]*?<\/p>/i);
      if (prefix && /^episode description\s*:\s*$/i.test(textContent(prefix[1]))) body = body.slice(prefix[0].length);
      return body.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '');
    }
  }
  return undefined;
}

async function linkedFeedDuration(page: string, canonical: string, fetcher: ProgrammeFetcher) {
  const feed = anchors(page).map(anchor => {
    try { return nasaUrl(anchor.attributes.href ?? '', canonical); } catch { return null; }
  }).find(url => url?.hostname === 'www.nasa.gov' && /^\/feeds\/podcasts\/curious-universe\/?$/.test(url.pathname)
    && !url.search);
  if (!feed) return undefined;
  try {
    // NASA's official RSS endpoint redirects to this exact publisher feed.
    // This exception is metadata-only; episode/caption downloads stay NASA-only.
    const response = await fetcher(feed.toString(), { redirect: 'follow' });
    if (!response.ok) return undefined;
    if (response.url && response.url !== feed.toString()
      && response.url !== 'https://feeds.megaphone.fm/nationalaeronauticsandspaceadministration8162188566') return undefined;
    const xml = await response.text();
    const field = (item: string, name: string) => {
      const raw = item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]?.trim();
      return raw === undefined ? undefined : decodeEpubEntities(raw.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')).trim();
    };
    const matches = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].filter(match => {
      try { return episodeUrl(field(match[1], 'link') ?? '') === canonical; } catch { return false; }
    });
    if (matches.length !== 1) return undefined;
    const item = matches[0][1], type = field(item, 'itunes:episodeType');
    if (type && type.toLowerCase() !== 'full') return undefined;
    const value = field(item, 'itunes:duration');
    if (!value) return undefined;
    if (/^\d+$/.test(value)) return duration(Number(value) * 1000);
    const time = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!time || Number(time[3]) > 59 || (time[1] !== undefined && Number(time[2]) > 59)) return undefined;
    return duration((Number(time[1] ?? 0) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000);
  } catch { return undefined; } // Keep valid text; unknown duration is not ready to read.
}

/** Explicit recovery of missing timing; never replaces the already saved text. */
export async function fetchProgrammeDuration(episode: ProgrammeEpisode, fetcher: ProgrammeFetcher): Promise<number | undefined> {
  const known = duration(episode.durationMs);
  if (known !== undefined) return known;
  const canonical = episodeUrl(episode.sourceUrl);
  const page = await download(canonical, fetcher);
  return episodeDuration(page, episode.title) ?? await linkedFeedDuration(page, canonical, fetcher);
}

function transcriptParagraphs(html: string, wholeDocument: boolean) {
  const heading = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .find(match => /^(?:episode\s+)?(?:full\s+)?transcript$/i.test(textContent(match[2])));
  let body: string;
  if (heading) {
    const start = heading.index! + heading[0].length;
    const remainder = html.slice(start);
    const following = [...remainder.matchAll(/<h([1-6])\b/gi)].find(match => Number(match[1]) <= Number(heading[1]));
    body = remainder.slice(0, following?.index ?? remainder.length);
  } else if (wholeDocument) body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  else {
    const podcast = nasaPodcastBody(html);
    if (podcast === undefined) return [];
    body = podcast;
  }
  body = body.replace(/<(script|style|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return textContent(body.replace(/<\/(?:p|li|pre|div|section|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<\/(?:td|th)>/gi, ' ')).split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
}

export async function fetchProgrammeTranscript(episode: ProgrammeEpisode, fetcher: ProgrammeFetcher): Promise<ProgrammeTranscript> {
  const canonical = episodeUrl(episode.sourceUrl);
  const page = await download(canonical, fetcher);
  let durationMs = duration(episode.durationMs) ?? episodeDuration(page, episode.title);
  let resourcePage = page, resourceUrl = canonical;
  const resourceLinks = anchors(page).filter(anchor => {
    if (!anchor.attributes.href || !fullEpisodeLink(page, anchor, episode)) return false;
    try { const url = nasaUrl(anchor.attributes.href, canonical); return url.hostname === 'svs.gsfc.nasa.gov' && /^\/\d+\/?$/.test(url.pathname); }
    catch { return false; }
  });
  const distinctResources = [...new Set(resourceLinks.map(anchor => nasaUrl(anchor.attributes.href, canonical).toString()))];
  if (distinctResources.length > 1) throw new Error('programme-resource-ambiguous');
  // At most the one explicitly related resource page, never a website crawl.
  if (distinctResources[0]) { resourceUrl = distinctResources[0]; resourcePage = await download(resourceUrl, fetcher); }
  const candidates = anchors(resourcePage).filter(anchor => anchor.attributes.href && fullEpisodeLink(resourcePage, anchor, episode))
    .map(anchor => { try { return nasaUrl(anchor.attributes.href, resourceUrl).toString(); } catch { return ''; } }).filter(Boolean);
  const captionUrls = [...new Set(candidates.filter(url => /\.(?:srt|vtt)(?:\?|$)/i.test(url)))];
  const srt = captionUrls.filter(url => /\.srt(?:\?|$)/i.test(url));
  const vtt = captionUrls.filter(url => /\.vtt(?:\?|$)/i.test(url));
  const preferred = srt.length ? srt : vtt;
  if (preferred.length > 1) throw new Error('programme-caption-resource-ambiguous');
  if (preferred[0]) {
    const sourceUrl = preferred[0];
    const format = /\.srt(?:\?|$)/i.test(sourceUrl) ? 'srt' : 'vtt';
    const parsed = parseProgrammeCaptions(await download(sourceUrl, fetcher), format);
    return { ...parsed, text: parsed.paragraphs.join('\n\n'), sourceUrl, format,
      durationMs: durationMs ?? parsed.cues.reduce((end, cue) => Math.max(end, cue.endMs), 0), language: parsed.language ?? episode.language };
  }
  const transcriptUrls = [...new Set(candidates.filter(url => /(?:transcript)[^/]*\.(?:html?|txt)(?:\?|$)/i.test(url)))];
  if (transcriptUrls.length > 1) throw new Error('programme-transcript-resource-ambiguous');
  const sourceUrl = transcriptUrls[0] ?? canonical;
  const transcript = transcriptUrls[0] ? await download(sourceUrl, fetcher) : page;
  const paragraphs = transcriptParagraphs(transcript, !!transcriptUrls[0]);
  if (!paragraphs.length) throw new Error('programme-transcript-not-found');
  // A single explicitly linked RSS metadata request, matching only this URL.
  // Never fetch the feed's audio enclosures or other episodes' transcripts.
  durationMs ??= await linkedFeedDuration(page, canonical, fetcher);
  return { text: paragraphs.join('\n\n'), paragraphs, cues: [], format: 'html', durationMs, language: episode.language, sourceUrl };
}

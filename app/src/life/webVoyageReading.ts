export type WebVoyageReadingStatus = 'body_excerpt' | 'search_preview' | 'metadata_only';

/** Describes acquired material only; it is not a claim that a model has read it. */
export function webVoyageReadingStatusText(status?: WebVoyageReadingStatus, sourceType: 'web' | 'github' = 'web'): string {
  if (sourceType === 'github') {
    if (status === 'body_excerpt') return '项目介绍摘录';
    if (status === 'search_preview') return '这次没有读到项目介绍。以下仅是搜索结果中的项目名称和简介。';
    if (status === 'metadata_only') return '这次没有读到项目介绍，也没有可用的项目简介，只取得了名称和链接。';
    return '这份旧记录没有注明是否读到项目介绍，以下是当时保存的内容。';
  }
  if (status === 'body_excerpt') return '正文摘录';
  if (status === 'search_preview') return '这次没有读到网页正文。以下仅是搜索结果中的标题和摘要。';
  if (status === 'metadata_only') return '这次没有读到网页正文，也没有可用的搜索摘要，只取得了标题和链接。';
  return '这份旧记录没有注明是否读到网页正文，以下是当时保存的内容。';
}

export function isWebVoyageShareableReading(entry: {
  sourceType?: 'web' | 'github'; readingStatus?: WebVoyageReadingStatus;
}): boolean {
  return entry.readingStatus === undefined || entry.readingStatus === 'body_excerpt';
}

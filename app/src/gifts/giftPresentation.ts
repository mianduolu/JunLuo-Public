import type { GiftDraftContents, GiftFileKind, GiftRecord } from './giftTypes';

export const GIFT_FILTERS = [
  { key: 'all', label: '全部' }, { key: 'mine', label: '我送的' }, { key: 'received', label: '她送的' },
] as const;

export function giftStatusLabel(gift: Pick<GiftRecord, 'deliveryStatus' | 'receptionStatus'> & Partial<Pick<GiftRecord, 'scheduledAt'>>) {
  if (gift.deliveryStatus === 'withdrawn') return '已撤回';
  if (gift.deliveryStatus === 'draft') return gift.scheduledAt ? '已记下准备时间' : '草稿';
  if (gift.deliveryStatus === 'scheduled') return '待赠送';
  return { unopened: '尚未拆开', deferred: '稍后拆开', opened: '已拆开', declined: '未收下' }[gift.receptionStatus];
}

export function giftDate(value: number | null) {
  if (value === null) return '';
  const date = new Date(value);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function giftKindLabel(kind: GiftFileKind | 'url') {
  return { image: '图片', audio: '音频', html: '小网页', url: '网页链接' }[kind];
}

export function giftByteSize(size: number) {
  return size < 1024 * 1024 ? `${Math.max(1, Math.ceil(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function giftErrorText(error: unknown) {
  const code = error instanceof Error ? error.message.match(/\bgift-[a-z-]+\b/g)?.at(-1) ?? '' : '';
  return ({
    'gift-stale-version': '这份礼物已更新，请重新打开后继续。',
    'gift-stale-data-epoch': '资料正在恢复，请稍后重新打开。',
    'gift-original-frozen': '已拆礼物保留当时的版本。',
    'gift-sender-only': '只有原赠送者可以补充附件。',
    'gift-empty-supplement': '请先选择要补充的附件。',
    'gift-withdraw-before-edit': '请先撤回，再修改这份礼物。',
    'gift-cancel-before-edit': '请先取消定时，再修改这份礼物。',
    'gift-not-scheduled': '这份礼物没有待执行的定时安排。',
    'gift-not-ready': '请填写名字，并放入至少一个原件。',
    'gift-invalid-cover': '请为包装选择一张图片。',
    'gift-invalid-time': '请检查准备日期和时间。',
    'gift-invalid-url': '请填写完整的 http 或 https 网页地址。',
    'gift-not-opened': '请先打开礼物，再查看里面的原件。',
    'gift-progress-conflict': '这份网页进度已更新，请重新打开后继续。',
    'gift-invalid-progress': '网页进度未能保存，请检查作品的存档数据。',
    'gift-storage-incompatible': '这个网页的本地存档接口暂不兼容。',
    'gift-audio-connection-unavailable': '尚未配置声音／音乐理解连接；原音仍可播放，尚未听取。',
    'gift-image-connection-unavailable': '尚未配置看图连接，原图尚未理解。',
    'gift-audio-format-unsupported': '当前听觉适配器不支持这个音频格式；请补充兼容原件，原音仍可播放。',
    'gift-audio-too-large': '音频原件仍可播放；编码后须小于 10 MB 才能提交理解，请补充较小的兼容文件。',
    'gift-image-format-unsupported': '当前看图适配器不支持这个图片格式，原图尚未理解。',
    'gift-original-missing': '原件暂不可读，尚未完成理解。',
    'gift-original-changed': '原件与保存记录不一致，请重新打开后检查。',
    'gift-understanding-config-changed': '模型设置已更新，请按新连接重试。',
    'gift-understanding-aborted': '本次理解已取消。',
    'gift-original-request-auth': '理解连接的密钥或权限需要检查，尚未完成理解。',
    'gift-original-request-rate-limited': '理解连接暂时限流或额度不足，尚未完成理解。',
    'gift-original-request-timeout': '理解请求超时，尚未完成理解。',
    'gift-original-request-cancelled': '本次理解已取消。',
    'gift-original-request-http-error': '理解连接未接受请求，请检查模型与原音输入兼容性。',
    'gift-original-request-empty-response': '理解连接没有返回正文，尚未完成理解。',
    'gift-original-request-incomplete-response': '理解正文未完整返回，尚未完成理解。',
    'gift-original-request-invalid-response': '理解连接返回的格式无法读取，尚未完成理解。',
    'gift-original-request-invalid-config': '请检查理解连接的地址、模型及密钥配置。',
    'gift-original-request-invalid-input': '这份原件无法提交给当前理解适配器。',
    'gift-original-request-provider-error': '理解服务返回错误，尚未完成理解。',
    'gift-original-request-preflight-failed': '本次理解的准备未完成，请重试。',
    'gift-original-request-network': '理解连接暂时无法访问，尚未完成理解。',
  } as Record<string, string>)[code] ?? '操作未完成，请重试。';
}

export function giftDraftContents(gift: GiftRecord): GiftDraftContents {
  return { title: gift.title, note: gift.note,
    cover: gift.cover ? { existingOriginalId: gift.cover.id } : null,
    attachments: gift.attachments.map(item => ({ existingId: item.id })),
    deliveryPlan: gift.scheduledAt === null ? null : { at: gift.scheduledAt, timeZone: gift.scheduledTimeZone ?? 'UTC' } };
}

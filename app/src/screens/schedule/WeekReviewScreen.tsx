import { memo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../../components/AppText';
import type { WeekReview } from '../../schedule/weekReviewStore';
import { managerStyles as s } from './managerStyles';
import { WeekReviewSection } from './WeekReviewSection';
type Props = {
    error: string;
    loading: boolean;
    onClose: () => void;
    onRefresh: () => void;
    review: WeekReview | null;
    weekEnd: string;
    weekStart: string;
};
export const WeekReviewScreen = memo(function WeekReviewScreen({ error, loading, onClose, onRefresh, review, weekEnd, weekStart }: Props) { const insets = useSafeAreaInsets(); const rangeLabel = `${weekStart.slice(5)} 到 ${weekEnd.slice(5)}`; return <View style={[s.page, { paddingBottom: Math.max(insets.bottom + 18, 34), paddingTop: Math.max(insets.top + 18, 34) }]}><View style={s.header}><Pressable onPress={onClose} style={s.backButton}><Text style={s.backText}>‹</Text></Pressable><View style={s.titleBlock}><Text style={s.title}>周回顾</Text><Text style={s.subtitle}>{rangeLabel}</Text></View><View style={s.headerSpacer}/></View><Pressable disabled={loading} onPress={onRefresh} style={[s.createCard, loading ? s.generateDisabled : null]}><Text style={s.createIcon}>↻</Text><View style={s.createCopy}><Text style={s.createTitle}>{review ? '重新生成' : '生成本周回顾'}</Text><Text style={s.createHint}>只根据本地真实任务、习惯、目标和耗时生成</Text></View><Text style={s.arrow}>›</Text></Pressable><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{loading ? <Text style={s.empty}>白云正在慢慢整理这一周走过的路。</Text> : null}{!loading && error ? <Text style={s.empty}>{error}</Text> : null}{!loading && !error && !review ? <Text style={s.empty}>周日晚上 21:00 后，白云会在这里回顾本周的任务、习惯和目标进展。现在也可以手动生成。</Text> : null}{review ? <><View style={s.summaryCard}><Text style={s.sectionTitle}>这一周</Text><Text style={s.body}>{review.summary}</Text></View><WeekReviewSection title="小胜利" items={review.wins} emptyText="本周的小胜利还等着被记录。"/><WeekReviewSection title="可以改善" items={review.gaps} emptyText="这一块可以先空着，不强行挑刺。"/><WeekReviewSection title="目标进展" items={review.goalProgress} emptyText="本周还没有明显的目标关联数据。"/><WeekReviewSection title="习惯洞察" items={review.habitInsights} emptyText="本周还没有习惯记录。"/><WeekReviewSection title="下周建议" items={review.nextWeekSuggestions} emptyText="下周可以先从一个很小的安排开始。"/><View style={s.messageCard}><Text style={s.sectionTitle}>白云寄语</Text><Text style={s.body}>{review.baiyunMessage}</Text></View></> : null}</ScrollView></View>; });

import { memo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../../components/AppText';
import { LIFE_AREAS, type Goal } from '../../schedule/goalStore';
import { managerStyles as s } from './managerStyles';
type Props = {
    goals: Goal[];
    onClose: () => void;
    onCreate: () => void;
    onOpenGoal: (goal: Goal) => void;
};
export const GoalManagerScreen = memo(function GoalManagerScreen({ goals, onClose, onCreate, onOpenGoal }: Props) { const insets = useSafeAreaInsets(); const groups = LIFE_AREAS.map(area => ({ area, goals: goals.filter(goal => goal.lifeArea === area.type) })).filter(group => group.goals.length); return <View style={[s.page, { paddingBottom: Math.max(insets.bottom + 18, 34), paddingTop: Math.max(insets.top + 18, 34) }]}><View style={s.header}><Pressable onPress={onClose} style={s.backButton}><Text style={s.backText}>‹</Text></Pressable><View style={s.titleBlock}><Text style={s.title}>目标</Text><Text style={s.subtitle}>{goals.length ? `记下了 ${goals.length} 个小方向` : '先写下一个温柔的小方向'}</Text></View><View style={s.headerSpacer}/></View><Pressable onPress={onCreate} style={s.createCard}><Text style={s.createIcon}>＋</Text><View style={s.createCopy}><Text style={s.createTitle}>新建目标</Text><Text style={s.createHint}>给某个领域放一个清晰一点的方向</Text></View><Text style={s.arrow}>›</Text></Pressable><ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{!goals.length ? <Text style={s.empty}>还没有目标。可以先从一个最想照顾的领域开始。</Text> : null}{groups.map(({ area, goals: items }) => <View key={area.type} style={s.areaSection}><View style={s.areaHeader}><Text style={s.areaTitle}>{area.icon} {area.label}</Text><Text style={s.areaCount}>{items.length}</Text></View>{items.map(goal => <Pressable key={goal.id} onPress={() => onOpenGoal(goal)} style={s.item}><View style={[s.dot, { backgroundColor: area.color }]}/><View style={s.itemCopy}><Text numberOfLines={2} style={s.itemTitle}>{goal.title}</Text><Text numberOfLines={1} style={s.itemMeta}>{goal.targetDate ? `截止 ${goal.targetDate} · ` : ''}{goal.goalType === 'direction' ? '方向型' : `${goal.progress}%`} · {goal.priority === 'high' ? '高优先级' : goal.priority === 'low' ? '低优先级' : '普通优先级'}</Text></View><Text style={s.arrow}>›</Text></Pressable>)}</View>)}</ScrollView></View>; });

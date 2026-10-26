import {
  useCallback,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactElement,
  type RefObject,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  type StyleProp,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import Animated from 'react-native-reanimated';
import type { EdgeInsets } from 'react-native-safe-area-context';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { homeImages, baiyunStatusPortraits } from '../assets/homeImages';
import { BackgroundSurface } from '../components/BackgroundSurface';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import { styles } from '../screens/ChatScreen.styles';
import { ChatHistorySearchScreen } from './ChatHistorySearchScreen';
import { ChatHistoryWindow } from './ChatHistoryWindow';
import type { useChatHistorySearchController } from './useChatHistorySearchController';
import { ChatComposer } from './ChatComposer';
import { ChatTypingContent } from './ChatTextControls';
import { ChatDrawer, type ChatDrawerHandle } from './ChatDrawer';
import { formatPlanTaskMeta } from './ChatMessageCards';
import { ChatModals } from './ChatModals';
import { ChatAppLaunchPicker, type useChatAppLaunchController } from './ChatAppLaunchPicker';
import { ChatDialerPicker, type useChatDialerController } from './ChatDialerPicker';
import { ChatReplyDiagnosticModal } from './ChatReplyDiagnosticCard';
import type { ChatReplyDiagnosticEntry } from './chatReplyDiagnosticPresentation';
import { ChatMessageList } from './ChatMessageList';
import { PokeAvatar } from './ChatPokeAvatar';
import { ChatProfilerBoundary } from './ChatProfilerBoundary';
import { ChatReviewTrays } from './ChatReviewTrays';
import { ChatWishDiscussion } from './ChatWishDiscussion';
import { TokenUsageRing } from './ChatTokenUsageRing';
import type { ChatReplyPhase } from './useChatReplyController';
import type { useChatScheduleController } from './useChatScheduleController';
import { FontPresentationProvider, useFontPreferences } from '../fonts/FontPreferences';
import { PhoneLockChatProjection } from '../phoneRestriction/phoneLockChatSurface';
import { PhoneLockChatPresentation } from '../phoneRestriction/PhoneLockChatPresentation';

type ScheduleController = ReturnType<typeof useChatScheduleController>;
type ComposerProps = ComponentProps<typeof ChatComposer>;
type DrawerNavigate = ComponentProps<typeof ChatDrawer>['navigate'];
type ModalsProps = ComponentProps<typeof ChatModals>;
type ReviewTraysProps = ComponentProps<typeof ChatReviewTrays>;

const EMPTY_CHAT_MESSAGES: SubjectiveMessage[] = [];

type ChatScreenViewProps = {
  phoneLockChat?: { messages: SubjectiveMessage[]; loading: boolean; failure: boolean; sleeping: boolean };
  wishDiscussion?: ComponentProps<typeof ChatWishDiscussion>;
  backstage?: ReactElement;
  background: {
    settings: ComponentProps<typeof BackgroundSurface>['settings'];
    skyTheme: ComponentProps<typeof BackgroundSurface>['skyTheme'];
  };
  composer: {
    bottomPadding: number;
    dockKeyboardStyle: StyleProp<ViewStyle>;
    liftStyle: StyleProp<ViewStyle>;
    onLayout: () => void;
    props: ComposerProps;
  };
  drawer: {
    insets: EdgeInsets;
    navigate: DrawerNavigate;
    onSearchHistory: () => void;
    ref: RefObject<ChatDrawerHandle | null>;
  };
  historySearch: ReturnType<typeof useChatHistorySearchController>;
  appLaunch: ReturnType<typeof useChatAppLaunchController>;
  dialer: ReturnType<typeof useChatDialerController>;
  error: {
    configured: boolean;
    message: string | null;
    onOpenSettings: () => void;
    onOpenDetails?: () => void;
    diagnosticEntry?: ChatReplyDiagnosticEntry | null;
    onCloseDetails?: () => void;
  };
  header: {
    availabilityText: string;
    baiyunHeartUnread: boolean;
    configured: boolean;
    contextUsagePercentage: number;
    onOpenBaiyunHeart: () => void;
    onOpenDrawer: () => void;
    onOpenSettings: () => void;
    onOpenTokenDetails: () => void;
    titleTextStyle: StyleProp<TextStyle>;
    tokenRingColor: string;
  };
  insets: EdgeInsets;
  messages: {
    active: boolean;
    configLoaded: boolean;
    hiddenHistoryCount: number;
    historyLoaded: boolean;
    listRef: RefObject<FlatList<SubjectiveMessage> | null>;
    messageRenderRevision: string;
    messages: SubjectiveMessage[];
    nearBottomRef: { current: boolean };
    onContentEdgeChange: () => void;
    onPokeEmpty: () => void;
    onRevealOlder: () => void;
    onUserScrollBegin: () => void;
    presentationMounted: boolean;
    pokeBubble: { anchorId: string; text: string } | null;
    renderMessageBubble: (message: SubjectiveMessage, messageIndex: number) => ReactElement | null;
    reversedVisibleMessages: SubjectiveMessage[];
    scrollToLatestOnOpenRef: { current: boolean };
    sessionMessagesLoading: boolean;
    visibleMessageStartIndex: number;
  };
  modals: ModalsProps;
  reviews: ReviewTraysProps;
  schedulePanels: {
    ambiguousScheduleText: string | null;
    composerKeyboardStyle: StyleProp<ViewStyle>;
    hasPendingPlanMessage: boolean;
    onAcceptAmbiguousSchedule: () => void;
    onAdjustGoal: () => void;
    onAdjustSchedule: () => void;
    onCancelGoal: () => void;
    onConfirmGoal: () => void;
    onConfirmSchedule: () => void;
    onDiscardSchedule: () => void;
    onRejectAmbiguousSchedule: () => void;
    pendingGoalProposal: ScheduleController['pendingGoalProposal'];
    pendingSchedulePlan: ScheduleController['pendingSchedulePlan'];
    scheduleAdjustmentMode: ScheduleController['scheduleAdjustmentMode'];
    schedulePlanSaving: boolean;
  };
  selection: {
    composerKeyboardStyle: StyleProp<ViewStyle>;
    memoryOpen: boolean;
    onCancelMemory: () => void;
    onConfirmMemory: () => void;
    selectedMemoryCount: number;
  };
  tools: {
    latestMemoryRecallCount: number | null;
    latestMemoryRecallLabel: string;
    messagesPresent: boolean;
    onOpenMemoryRecall: () => void;
    onOrganizeMemories: () => void;
    onStopMemoryOrganization?: () => void;
    onContinueMemoryOrganization?: () => void;
    unfinishedOrganization?: boolean;
    onOrganizeSelected: () => void;
    organizing: boolean;
    replyBusy: boolean;
    titleTextStyle: StyleProp<TextStyle>;
  };
  typing: {
    queuedMessageCount: number;
    replyPhase: ChatReplyPhase;
    titleTextStyle: StyleProp<TextStyle>;
    visible: boolean;
  };
};

function TypingIndicator({ queuedMessageCount, replyPhase, titleTextStyle, visible }: ChatScreenViewProps['typing']) {
  if (!visible) return null;
  return (
    <View style={styles.messageRow}>
      <Image resizeMode="contain" source={homeImages.youPortraitNeutral} style={styles.messageAvatar} />
      <View style={styles.messageBody}>
        <View style={styles.messageMeta}>
          <Text style={[styles.messageName, titleTextStyle]}>白云小姐</Text>
        </View>
        <View style={[styles.iBubble, styles.typingBubble]}>
          <ChatTypingContent>
            {queuedMessageCount
              ? `还有 ${queuedMessageCount} 条等她接住...`
              : replyPhase === 'waitingForUser'
                ? '等你慢慢说完...'
                : replyPhase === 'slowNetwork'
                  ? '网络有点慢……'
                  : '正在输入中……'}
          </ChatTypingContent>
        </View>
      </View>
    </View>
  );
}

export function ChatScreenView({
  phoneLockChat,
  wishDiscussion,
  backstage,
  background,
  composer,
  drawer,
  error,
  header,
  historySearch,
  appLaunch,
  dialer,
  insets,
  messages,
  modals,
  reviews,
  schedulePanels,
  selection,
  tools,
  typing,
}: ChatScreenViewProps) {
  const font = useFontPreferences();
  const renderMessageBubbleRef = useRef(messages.renderMessageBubble);
  renderMessageBubbleRef.current = messages.renderMessageBubble;
  const messageCallbacksRef = useRef({
    onContentEdgeChange: messages.onContentEdgeChange,
    onPokeEmpty: messages.onPokeEmpty,
    onRevealOlder: messages.onRevealOlder,
    onUserScrollBegin: messages.onUserScrollBegin,
  });
  messageCallbacksRef.current = {
    onContentEdgeChange: messages.onContentEdgeChange,
    onPokeEmpty: messages.onPokeEmpty,
    onRevealOlder: messages.onRevealOlder,
    onUserScrollBegin: messages.onUserScrollBegin,
  };
  const onContentEdgeChange = useCallback(() => messageCallbacksRef.current.onContentEdgeChange(), []);
  const onPokeEmpty = useCallback(() => messageCallbacksRef.current.onPokeEmpty(), []);
  const onRevealOlder = useCallback(() => messageCallbacksRef.current.onRevealOlder(), []);
  const onUserScrollBegin = useCallback(() => messageCallbacksRef.current.onUserScrollBegin(), []);
  const listData = messages.historyLoaded
    && messages.configLoaded
    && !messages.sessionMessagesLoading
    && messages.messages.length
    ? messages.reversedVisibleMessages
    : EMPTY_CHAT_MESSAGES;
  const listEmpty = !messages.historyLoaded
    || !messages.configLoaded
    || messages.sessionMessagesLoading
    || !messages.messages.length;
  const listEmptyComponent = useMemo(
    () => !messages.historyLoaded || !messages.configLoaded || messages.sessionMessagesLoading ? (
      <ActivityIndicator color={colors.primary} />
    ) : !messages.messages.length ? (
      <View style={styles.emptyState}>
        <PokeAvatar
          bubble={messages.pokeBubble?.anchorId === 'empty' ? messages.pokeBubble.text : undefined}
          imageStyle={styles.emptyPortrait}
          onDoubleTap={onPokeEmpty}
          source={phoneLockChat?.sleeping ? baiyunStatusPortraits.asleep : homeImages.youPortraitNeutral}
        />
        <Text style={[styles.emptyTitle, header.titleTextStyle]}>白云小姐在这里</Text>
        <Text style={[styles.emptyText, header.titleTextStyle]}>小仓鼠，今天想从哪里说起呀？</Text>
      </View>
    ) : null,
    [
      header.titleTextStyle,
      messages.configLoaded,
      messages.historyLoaded,
      messages.messages.length,
      messages.pokeBubble,
      messages.sessionMessagesLoading,
      onPokeEmpty,
      phoneLockChat?.sleeping,
    ],
  );
  const listFooterComponent = useMemo(
    () => messages.hiddenHistoryCount
      && messages.historyLoaded
      && messages.configLoaded
      && messages.messages.length ? (
        <Text style={[styles.hiddenHistoryNotice, header.titleTextStyle]}>
          上拉继续加载更早的 {messages.hiddenHistoryCount} 条消息
        </Text>
      ) : null,
    [
      header.titleTextStyle,
      messages.configLoaded,
      messages.hiddenHistoryCount,
      messages.historyLoaded,
      messages.messages.length,
    ],
  );
  const listHeaderComponent = useMemo(
    () => <TypingIndicator {...typing} />,
    [typing.queuedMessageCount, typing.replyPhase, typing.titleTextStyle, typing.visible],
  );
  if (phoneLockChat) return <PhoneLockChatProjection>
    <FontPresentationProvider value={font}>
      <PhoneLockChatPresentation {...phoneLockChat}
        revision={messages.messageRenderRevision} renderMessage={messages.renderMessageBubble}
        composer={composer.props} empty={listEmptyComponent} typing={listHeaderComponent} error={error.message} />
    </FontPresentationProvider>
  </PhoneLockChatProjection>;
  return (
    <ChatProfilerBoundary id="ChatShell">
      <BackgroundSurface
        active={messages.active}
        settings={background.settings}
        skyTheme={background.skyTheme}
        weatherKind="clear"
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          style={[styles.page, { paddingTop: Math.max(insets.top, 30) }]}
        >
          {messages.presentationMounted ? (
          <>
          <View style={styles.header}>
            <Pressable accessibilityLabel="打开功能栏" onPress={header.onOpenDrawer} style={styles.headerButton}>
              <Text style={[styles.menuIcon, header.titleTextStyle]}>☰</Text>
            </Pressable>
            <View style={styles.headerCenter}>
              <View style={styles.titleRow}>
                <Text style={[styles.title, header.titleTextStyle]}>白云小姐</Text>
                {header.baiyunHeartUnread ? (
                  <Pressable
                    accessibilityLabel="查看新的白云动态"
                    onPress={header.onOpenBaiyunHeart}
                    style={styles.heartNoticeButton}
                  >
                    <Text style={styles.heartNoticeText}>☁</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.connectionRow}>
                <View style={[styles.connectionDot, header.configured ? styles.connectionDotReady : null]} />
                <Text style={[styles.subtitle, header.titleTextStyle]}>{header.availabilityText}</Text>
              </View>
            </View>
            <View style={styles.headerActions}>
              <Pressable
                accessibilityLabel="查看上下文用量"
                onPress={header.onOpenTokenDetails}
                style={styles.tokenRingButton}
              >
                <TokenUsageRing color={header.tokenRingColor} percentage={header.contextUsagePercentage} />
              </Pressable>
              <Pressable accessibilityLabel="连接设置" onPress={header.onOpenSettings} style={styles.headerButton}>
                <Image resizeMode="contain" source={homeImages.settings} style={styles.settingsIcon} />
              </Pressable>
            </View>
          </View>

          {(
            <View style={styles.chatTools}>
              {tools.latestMemoryRecallCount !== null ? (
                <Pressable onPress={tools.onOpenMemoryRecall} style={styles.memoryRecallButton}>
                  <Text numberOfLines={2} style={styles.memoryRecallButtonText}>
                    {tools.latestMemoryRecallLabel}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                disabled={tools.replyBusy && !tools.organizing}
                onPress={tools.organizing ? tools.onStopMemoryOrganization
                  : tools.unfinishedOrganization ? tools.onContinueMemoryOrganization : tools.onOrganizeMemories}
                style={styles.clearButton}
              >
                <Text style={[styles.clearText, tools.titleTextStyle]}>
                  {tools.organizing ? '停止整理' : tools.unfinishedOrganization ? '继续上次整理' : '整理回忆'}
                </Text>
              </Pressable>
              <Pressable
                disabled={tools.replyBusy || tools.organizing}
                onPress={tools.onOrganizeSelected}
                style={styles.clearButton}
              >
                <Text style={[styles.clearText, tools.titleTextStyle]}>自选整理</Text>
              </Pressable>
            </View>
          )}

          {historySearch.browsing ? <ChatHistoryWindow controller={historySearch} renderMessage={messages.renderMessageBubble} /> : <ChatMessageList
            contentEmpty={listEmpty}
            data={listData}
            emptyComponent={listEmptyComponent}
            footerComponent={listFooterComponent}
            headerComponent={listHeaderComponent}
            hiddenHistoryCount={messages.hiddenHistoryCount}
            liftStyle={composer.liftStyle}
            listRef={messages.listRef}
            messageRenderRevision={messages.messageRenderRevision}
            nearBottomRef={messages.nearBottomRef}
            onContentEdgeChange={onContentEdgeChange}
            onRevealOlder={onRevealOlder}
            onUserScrollBegin={onUserScrollBegin}
            renderMessageBubbleRef={renderMessageBubbleRef}
            visibleMessageStartIndex={messages.visibleMessageStartIndex}
          />}
          <ChatProfilerBoundary id="ChatPanels">
          {error.message ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{error.message}</Text>
              {error.onOpenDetails ? (
                <Pressable accessibilityRole="button" onPress={error.onOpenDetails}>
                  <Text style={styles.errorAction}>查看详情</Text>
                </Pressable>
              ) : null}
              {!error.configured ? (
                <Pressable onPress={error.onOpenSettings}>
                  <Text style={styles.errorAction}>去设置</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {schedulePanels.ambiguousScheduleText ? (
            <Animated.View style={[styles.groupScheduleCard, schedulePanels.composerKeyboardStyle]}>
              <Text style={styles.candidateLabel}>要收成安排吗？</Text>
              <Text numberOfLines={2} style={styles.groupSchedulePrompt}>
                {schedulePanels.ambiguousScheduleText}
              </Text>
              <View style={styles.candidateActions}>
                <Pressable onPress={schedulePanels.onRejectAmbiguousSchedule} style={styles.candidateDismiss}>
                  <Text style={styles.candidateDismissText}>不是</Text>
                </Pressable>
                <Pressable onPress={schedulePanels.onAcceptAmbiguousSchedule} style={styles.candidateSave}>
                  <Text style={styles.candidateSaveText}>是的</Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : null}

          {schedulePanels.pendingGoalProposal ? (
            <Animated.View style={[styles.groupScheduleCard, schedulePanels.composerKeyboardStyle]}>
              <View style={styles.groupScheduleHeader}>
                <View>
                  <Text style={styles.candidateLabel}>待确认目标</Text>
                  <Text style={styles.groupScheduleDate}>{schedulePanels.pendingGoalProposal.extracted.title}</Text>
                </View>
                <Text style={styles.groupScheduleCount}>
                  {schedulePanels.pendingGoalProposal.goalType === 'countdown'
                    ? '倒计时'
                    : schedulePanels.pendingGoalProposal.goalType === 'time_based'
                      ? '时间型'
                      : '方向型'}
                </Text>
              </View>
              {schedulePanels.pendingGoalProposal.extracted.description ? (
                <Text style={styles.unscheduledText}>
                  {schedulePanels.pendingGoalProposal.extracted.description}
                </Text>
              ) : null}
              <Text style={styles.unscheduledText}>
                {schedulePanels.pendingGoalProposal.goalType === 'countdown'
                  ? `目标量：${schedulePanels.pendingGoalProposal.extracted.number} ${schedulePanels.pendingGoalProposal.extracted.unit ?? ''}`
                  : schedulePanels.pendingGoalProposal.goalType === 'time_based'
                    ? `预计总投入：${schedulePanels.pendingGoalProposal.extracted.estimatedHours} 小时`
                    : '不硬算百分比，保留为长期方向'}
              </Text>
              <Text style={styles.unscheduledText}>
                频率：{schedulePanels.pendingGoalProposal.extracted.frequency === 'daily'
                  ? '每天'
                  : schedulePanels.pendingGoalProposal.extracted.frequency === 'weekly'
                    ? '每周'
                    : '不自动生成动作'}
                {schedulePanels.pendingGoalProposal.extracted.deadline
                  ? ` · 截止 ${schedulePanels.pendingGoalProposal.extracted.deadline}`
                  : ''}
              </Text>
              <View style={styles.candidateActions}>
                <Pressable onPress={schedulePanels.onCancelGoal} style={styles.candidateDismiss}>
                  <Text style={styles.candidateDismissText}>不建了</Text>
                </Pressable>
                <Pressable onPress={schedulePanels.onAdjustGoal} style={styles.candidateDismiss}>
                  <Text style={styles.candidateDismissText}>改一下</Text>
                </Pressable>
                <Pressable onPress={schedulePanels.onConfirmGoal} style={styles.candidateSave}>
                  <Text style={styles.candidateSaveText}>确认创建</Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : null}

          {schedulePanels.pendingSchedulePlan && !schedulePanels.hasPendingPlanMessage ? (
            <Animated.View style={[styles.groupScheduleCard, schedulePanels.composerKeyboardStyle]}>
              <View style={styles.groupScheduleHeader}>
                <View>
                  <Text style={styles.candidateLabel}>待确认整组安排</Text>
                  <Text style={styles.groupScheduleDate}>{schedulePanels.pendingSchedulePlan.dateKey}</Text>
                </View>
                <Text style={styles.groupScheduleCount}>
                  {schedulePanels.pendingSchedulePlan.scheduled.slots.length} 个时间块
                </Text>
              </View>
              <ScrollView style={styles.groupScheduleScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                {schedulePanels.pendingSchedulePlan.scheduled.slots.map((slot) => (
                  <View key={`${slot.taskId}-${slot.segmentIndex}`} style={styles.groupScheduleRow}>
                    <Text style={styles.groupScheduleTime}>
                      {new Date(slot.startAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                      })}
                    </Text>
                    <View style={styles.groupScheduleTask}>
                      <Text numberOfLines={2} style={styles.groupScheduleTitle}>{slot.displayTitle}</Text>
                      <Text style={styles.scheduleMeta}>
                        {formatPlanTaskMeta({
                          category: slot.category,
                          quadrant: slot.quadrant,
                          estimatedMinutes: slot.estimatedMinutes,
                        })}
                      </Text>
                    </View>
                  </View>
                ))}
                {schedulePanels.pendingSchedulePlan.scheduled.floatingCommitments.length ? (
                  <View style={styles.unscheduledSection}>
                    <Text style={styles.unscheduledHeading}>已有的每日挑战 · 找时间做</Text>
                    {schedulePanels.pendingSchedulePlan.scheduled.floatingCommitments.map((item) => (
                      <Text key={item.id} style={styles.unscheduledText}>
                        · {item.title}（{item.estimatedMinutes}分钟 · 连续{item.streak}天{item.completed ? ' · 已完成' : ''}）
                      </Text>
                    ))}
                  </View>
                ) : null}
                {schedulePanels.pendingSchedulePlan.scheduled.unscheduled.length ? (
                  <View style={styles.unscheduledSection}>
                    <Text style={styles.unscheduledHeading}>找时间做</Text>
                    {schedulePanels.pendingSchedulePlan.scheduled.unscheduled.map(({ task, reason }) => (
                      <Text key={task.id} style={styles.unscheduledText}>
                        · {task.title}（{formatPlanTaskMeta(task)} · {reason === 'missing-estimate' ? '待补估时' : '当天暂时放不下'}）
                      </Text>
                    ))}
                  </View>
                ) : null}
                {schedulePanels.pendingSchedulePlan.reviewSuggestions.length ? (
                  <View style={styles.planReviewSection}>
                    <Text style={styles.unscheduledHeading}>白云看了一眼</Text>
                    {schedulePanels.pendingSchedulePlan.reviewSuggestions.map((suggestion) => (
                      <Text key={suggestion} style={styles.unscheduledText}>· {suggestion}</Text>
                    ))}
                  </View>
                ) : null}
              </ScrollView>
              {schedulePanels.scheduleAdjustmentMode ? (
                <Text style={styles.adjustmentHint}>
                  直接在聊天框告诉我怎么改，下一条消息会更新这张卡。
                </Text>
              ) : null}
              <View style={styles.groupScheduleActions}>
                <Pressable
                  disabled={schedulePanels.schedulePlanSaving}
                  hitSlop={10}
                  onPress={schedulePanels.onDiscardSchedule}
                  style={styles.groupScheduleGhost}
                >
                  <Text style={styles.candidateDismissText}>今天不想了</Text>
                </Pressable>
                <Pressable
                  disabled={schedulePanels.schedulePlanSaving}
                  hitSlop={10}
                  onPress={schedulePanels.onAdjustSchedule}
                  style={styles.groupScheduleGhost}
                >
                  <Text style={styles.candidateDismissText}>调整一下</Text>
                </Pressable>
                <Pressable
                  disabled={schedulePanels.schedulePlanSaving}
                  hitSlop={10}
                  onPress={schedulePanels.onConfirmSchedule}
                  style={styles.groupScheduleSave}
                >
                  <Text style={styles.candidateSaveText}>
                    {schedulePanels.schedulePlanSaving ? '保存中' : '就这样'}
                  </Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : null}

          <ChatReviewTrays {...reviews} />
          {wishDiscussion ? <Animated.View style={composer.dockKeyboardStyle}>
            <ChatWishDiscussion {...wishDiscussion} />
          </Animated.View> : null}

          {selection.memoryOpen ? (
            <Animated.View style={[styles.favoriteSelectionBar, selection.composerKeyboardStyle]}>
              <Text style={styles.favoriteSelectionText}>已选择 {selection.selectedMemoryCount} 条</Text>
              <View style={styles.favoriteSelectionActions}>
                <Pressable onPress={selection.onCancelMemory} style={styles.favoriteSelectionCancel}>
                  <Text style={styles.favoriteSelectionCancelText}>取消</Text>
                </Pressable>
                <Pressable
                  disabled={!selection.selectedMemoryCount}
                  onPress={selection.onConfirmMemory}
                  style={[
                    styles.favoriteSelectionConfirm,
                    !selection.selectedMemoryCount && styles.disabledButton,
                  ]}
                >
                  <Text style={styles.favoriteSelectionConfirmText}>整理已选</Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : null}
          </ChatProfilerBoundary>
          </>
          ) : null}

          <ChatProfilerBoundary id="ChatComposer">
          <Animated.View
            onLayout={composer.onLayout}
            style={[
              styles.composerDock,
              { paddingBottom: composer.bottomPadding },
              composer.dockKeyboardStyle,
            ]}
          >
            {backstage}
            <ChatComposer {...composer.props} />
          </Animated.View>
          </ChatProfilerBoundary>
        </KeyboardAvoidingView>
        {messages.presentationMounted ? (
          <>
            <ChatDrawer
              insets={drawer.insets}
              navigate={drawer.navigate}
              onSearchHistory={drawer.onSearchHistory}
              ref={drawer.ref}
            />
            <ChatHistorySearchScreen controller={historySearch} />
            <ChatModals {...modals} />
            <ChatAppLaunchPicker controller={appLaunch} />
            <ChatDialerPicker controller={dialer} />
            {error.onCloseDetails ? <ChatReplyDiagnosticModal entry={error.diagnosticEntry ?? null} onClose={error.onCloseDetails} /> : null}
          </>
        ) : null}
      </BackgroundSurface>
    </ChatProfilerBoundary>
  );
}

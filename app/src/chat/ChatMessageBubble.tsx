import type { ReactNode } from 'react';
import {
  Image,
  PanResponder,
  Pressable,
  type StyleProp,
  type TextStyle,
  View,
} from 'react-native';
import type {
  MessageMusicCard,
  MusicSong,
  SubjectiveMessage,
} from '../ai/subjectiveMessages';
import { homeImages } from '../assets/homeImages';
import { AppText as Text } from '../components/AppText';
import { MusicMessageCard } from '../music/MusicMessageCard';
import { scheduleReminderPersonaLabel } from '../schedule/scheduleReminderPersona';
import { styles } from '../screens/ChatScreen.styles';
import { PokeAvatar } from './ChatPokeAvatar';
import { formatChatBubbleDateTime, getReplyAuthorLabel } from './chatMessageDisplay';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import type { MusicControlAction } from '../tools/musicPlaybackBridge';
import { VoiceCallRecordCard } from '../voiceCall/VoiceCallRecordCard';
import { ChatReadingReferenceCard } from './ChatReadingReferenceCard';

const REPLY_SWIPE_TRIGGER_DX = 54;

type ChatMessageBubbleProps = {
  modalActionsDisabled?: boolean;
  portraitSource?: number;
  assistantRoundLiked: boolean;
  canRetryDelivery: boolean;
  cards: ReactNode;
  currentSongId?: string;
  displayedContent: string;
  message: SubjectiveMessage;
  messageMusicCards: MessageMusicCard[];
  messageSelected: boolean;
  messageSelectionMode: boolean;
  memoryOrganizing: boolean;
  musicIsPlaying: boolean;
  musicShowCandidates: boolean;
  onLike: () => void;
  onLongPress?: () => void;
  onOrganizeVoiceCallRecord?: () => void;
  onMusicError: (notice: string) => void;
  onControlMusic: (action: MusicControlAction) => Promise<void>;
  onPlayMusic: (song: MusicSong) => Promise<void>;
  onPoke: () => void;
  onPreviewImage: (uri: string) => void;
  onReply: () => void;
  onRetryDelivery: () => void;
  onRetryMusic: (keyword: string, cardIndex: number) => void;
  onToggleSelection: () => void;
  pokeBubble?: string;
  renderedContent: ReactNode;
  showAssistantRoundLike: boolean;
  titleTextStyle?: StyleProp<TextStyle>;
  transcriptTextStyle?: StyleProp<TextStyle>;
};

function imageStatusLabel(image: NonNullable<SubjectiveMessage['images']>[number]) {
  if (image.visionStatus === 'pending') return '解析中';
  if (image.visionStatus === 'ready') return '已看图';
  if (image.visionStatus === 'metadata_only') return '未配置看图模型';
  return '没看清';
}

export function ChatMessageBubble({
  modalActionsDisabled = false,
  portraitSource = homeImages.youPortraitNeutral,
  assistantRoundLiked,
  canRetryDelivery,
  cards,
  currentSongId,
  displayedContent,
  message,
  messageMusicCards,
  messageSelected,
  messageSelectionMode,
  memoryOrganizing,
  musicIsPlaying,
  musicShowCandidates,
  onLike,
  onLongPress,
  onOrganizeVoiceCallRecord,
  onMusicError,
  onControlMusic,
  onPlayMusic,
  onPoke,
  onPreviewImage,
  onReply,
  onRetryDelivery,
  onRetryMusic,
  onToggleSelection,
  pokeBubble,
  renderedContent,
  showAssistantRoundLike,
  titleTextStyle,
  transcriptTextStyle,
}: ChatMessageBubbleProps) {
  if (message.voiceCallRecord) {
    return (
      <VoiceCallRecordCard
        onDelete={onLongPress}
        onOrganize={onOrganizeVoiceCallRecord}
        organizing={memoryOrganizing}
        record={message.voiceCallRecord}
      />
    );
  }
  const messageImages = message.images ?? [];
  const messageSticker = message.sticker;
  const hasVoice = !!message.voice;
  const hasImages = messageImages.length > 0;
  const hasSticker = !!messageSticker;
  const assistantTechnicalFailure = message.role === 'I'
    && message.deliveryStatus === 'failed'
    && !!message.deliveryError?.trim();
  const imageTextBubble = hasImages && !!displayedContent && !hasVoice && !hasSticker && !assistantTechnicalFailure;
  const canSwipeReply = !messageSelectionMode;
  const replyPanResponder = PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gestureState) =>
      canSwipeReply
      && gestureState.dx > 18
      && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.4,
    onPanResponderRelease: (_event, gestureState) => {
      if (gestureState.dx >= REPLY_SWIPE_TRIGGER_DX) onReply();
    },
    onPanResponderTerminate: (_event, gestureState) => {
      if (gestureState.dx >= REPLY_SWIPE_TRIGGER_DX) onReply();
    },
  });

  const replyQuote = message.replyTo ? (
    <View style={[styles.replyQuote, message.role === 'you' ? styles.replyQuoteMine : null]}>
      <Text numberOfLines={1} style={styles.replyQuoteAuthor}>
        {getReplyAuthorLabel(message.replyTo.role)}
      </Text>
      <Text numberOfLines={2} style={styles.replyQuoteText}>
        {message.replyTo.content}
      </Text>
    </View>
  ) : null;

  const bubble = (
    <View style={[styles.messageRow, message.role === 'you' ? styles.youMessageRow : null]}>
      {message.role === 'I' && !assistantTechnicalFailure ? (
        <View style={styles.avatarActionColumn}>
          <PokeAvatar
            bubble={pokeBubble}
            doubleTapDisabled={messageSelectionMode}
            imageStyle={styles.messageAvatar}
            onDoubleTap={onPoke}
            source={portraitSource}
          />
          {!messageSelectionMode ? (
            <Pressable
              accessibilityLabel="回复这条消息"
              hitSlop={8}
              onPress={onReply}
              style={styles.avatarReplyButton}
            >
              <Text style={styles.avatarReplyText}>↩</Text>
            </Pressable>
          ) : null}
        </View>
      ) : message.role === 'you' ? (
        <Image resizeMode="contain" source={homeImages.mePortraitDefault} style={styles.messageAvatar} />
      ) : (
        <View style={styles.messageAvatar} />
      )}
      <View style={[styles.messageBody, message.role === 'you' ? styles.youMessageBody : null]}>
        <View style={[styles.messageMeta, message.role === 'you' ? styles.youMessageMeta : null]}>
          <Text style={[styles.messageName, titleTextStyle]}>
            {assistantTechnicalFailure ? '君落' : message.role === 'I' ? '白云小姐' : '小仓鼠'}
          </Text>
          {message.source === 'schedule-reminder' || message.source === 'schedule-companion' ? (
            <Text style={styles.reminderBadge}>{scheduleReminderPersonaLabel(message.scheduleReminderPersona)}</Text>
          ) : null}
          {!assistantTechnicalFailure && (message.source === 'proactive-message' || message.source === 'nearby-world-active') ? (
            <Text style={styles.reminderBadge}>{message.source === 'nearby-world-active' ? '陪小仓鼠看路' : '前来看看'}</Text>
          ) : null}
          {message.source === 'tool-call' ? (
            <Text style={styles.reminderBadge}>工具回执</Text>
          ) : null}
          <Text numberOfLines={1} style={[styles.messageTime, titleTextStyle]}>
            {formatChatBubbleDateTime(message.createdAt)}
          </Text>
          {showAssistantRoundLike && !messageSelectionMode && !assistantTechnicalFailure ? (
            <Pressable
              accessibilityLabel={assistantRoundLiked ? '取消喜欢这轮回复' : '喜欢这轮回复'}
              onPress={onLike}
              style={[styles.replyLikeButton, assistantRoundLiked && styles.replyLikeButtonActive]}
            >
              <Text style={[styles.replyLikeText, assistantRoundLiked && styles.replyLikeTextActive]}>
                {assistantRoundLiked ? '♥' : '♡'}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {assistantTechnicalFailure || displayedContent || message.voice || hasImages || hasSticker || message.replyTo || message.readingReference ? (
          <View style={styles.swipeReplyFrame} {...replyPanResponder.panHandlers}>
            <Pressable
              onLongPress={onLongPress}
              onPress={messageSelectionMode ? onToggleSelection : undefined}
              style={[
                hasVoice || hasImages || hasSticker ? styles.voiceOuterBubble : message.role === 'I' ? styles.iBubble : styles.youBubble,
                messageSelectionMode && messageSelected ? styles.favoriteSelectedBubble : null,
              ]}
            >
              {!imageTextBubble ? replyQuote : null}
              {message.readingReference ? <ChatReadingReferenceCard reference={message.readingReference} onLongPress={onLongPress}
                onSelect={messageSelectionMode ? onToggleSelection : undefined} /> : null}
              {hasImages ? (() => {
                const image = messageImages[0];
                return (
                  <View style={[styles.messageImageBlock, message.role === 'you' ? styles.youMessageImageBlock : null]}>
                    <Pressable disabled={modalActionsDisabled} onPress={() => onPreviewImage(image.uri)} style={styles.messageImageFrame}>
                      <Image resizeMethod="resize" resizeMode="cover" source={{ uri: image.uri }} style={styles.messageImageThumb} />
                    </Pressable>
                    <Text style={[
                      styles.messageImageStatus,
                      image.visionStatus === 'ready' ? styles.messageImageStatusReady : null,
                      image.visionStatus === 'error' ? styles.messageImageStatusError : null,
                    ]}>
                      {imageStatusLabel(image)}
                    </Text>
                  </View>
                );
              })() : null}
              {messageSticker ? (
                <View style={styles.messageStickerBlock}>
                  <Pressable accessibilityLabel="预览表情包" disabled={modalActionsDisabled} onPress={() => onPreviewImage(messageSticker.uri)} style={styles.messageStickerFrame}>
                    <Image resizeMode="cover" source={{ uri: messageSticker.uri }} style={styles.messageStickerImage} />
                  </Pressable>
                </View>
              ) : null}
              {message.voice ? (
                <VoiceMessageBubble
                  role={message.role}
                  transcriptTextStyle={transcriptTextStyle}
                  voice={message.voice}
                />
              ) : assistantTechnicalFailure ? (
                <Text style={styles.bubbleText}>{message.deliveryError}</Text>
              ) : imageTextBubble ? (
                <View style={message.role === 'I' ? styles.iBubble : styles.youBubble}>
                  {replyQuote}
                  <Text style={styles.bubbleText}>{renderedContent}</Text>
                </View>
              ) : (
                <Text style={styles.bubbleText}>{renderedContent}</Text>
              )}
            </Pressable>
          </View>
        ) : null}
        {cards}
        {message.role === 'you' && message.deliveryStatus === 'failed' ? (
          <Pressable
            accessibilityLabel="重新发送这条消息"
            disabled={!canRetryDelivery}
            onPress={onRetryDelivery}
            style={[styles.deliveryRetryButton, !canRetryDelivery && styles.deliveryRetryButtonDisabled]}
          >
            <Text style={styles.deliveryRetryIcon}>!</Text>
            <Text style={styles.deliveryRetryText}>
              {canRetryDelivery ? '重新发送' : '未送达'}
            </Text>
          </Pressable>
        ) : null}
        {message.role === 'I'
          ? messageMusicCards.map((musicCard, cardIndex) => (
            <MusicMessageCard
              key={`${message.id}-music-${cardIndex}-${musicCard.keyword}`}
              card={musicCard}
              currentSongId={currentSongId}
              isPlaying={musicIsPlaying}
              onControl={onControlMusic}
              onError={onMusicError}
              onPlaySong={onPlayMusic}
              onRetry={() => onRetryMusic(musicCard.keyword, cardIndex)}
              showCandidates={musicShowCandidates}
            />
          ))
          : null}
      </View>
    </View>
  );

  if (!messageSelectionMode) return <View key={message.id}>{bubble}</View>;

  return (
    <View key={message.id} style={styles.favoriteSelectableRow}>
      <Pressable
        accessibilityLabel={messageSelected ? '取消选择这条消息' : '选择这条消息'}
        onPress={onToggleSelection}
        style={[styles.favoriteCheck, messageSelected && styles.favoriteCheckSelected]}
      >
        <Text style={messageSelected ? styles.favoriteCheckTextSelected : styles.favoriteCheckText}>
          {messageSelected ? '✓' : ''}
        </Text>
      </Pressable>
      <View style={styles.favoriteSelectableContent}>{bubble}</View>
    </View>
  );
}

import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { styles } from '../screens/ChatScreen.styles';
import { ChatTextAction, ChatTextInput } from './ChatTextControls';
import { ChatReadingReferenceCard } from './ChatReadingReferenceCard';
import type { ReadingReference } from '../reading/readingReference';
import { compactReplyText, getReplyAuthorLabel } from './chatMessageDisplay';
import { VoiceHoldLabel } from './ChatVoiceHoldLabel';

export type ChatComposerProps = {
  readingReference?: ReadingReference | null;
  onRemoveReadingReference?: () => void;
  configLoaded: boolean;
  configured: boolean;
  draftText: string;
  draftResetVersion: number;
  imageSending: boolean;
  inputRef: RefObject<React.ElementRef<typeof TextInput> | null>;
  memoryNotice: string | null;
  morePanelNotice: string | null;
  morePanelOpen: boolean;
  musicAutoplay: boolean;
  musicConnectionOpen: boolean;
  musicCookieBusy: boolean;
  musicCookieDraft: string;
  musicCookieSaved: boolean;
  musicEnabled: boolean;
  musicMultipleCardsEnabled: boolean;
  musicSettingsOpen: boolean;
  notebookTitle: string | null;
  onCancelNotebook: () => void;
  onCancelReply: () => void;
  onCancelVoice: () => void;
  onChangeDraft: (value: string) => void;
  onChangeMusicAutoplay: (enabled: boolean) => void;
  onChangeMusicCookie: (value: string) => void;
  onChangeMusicEnabled: (enabled: boolean) => void;
  onChangeMusicMultipleCards: (enabled: boolean) => void;
  onChangeWaitingMode: (enabled: boolean) => void;
  onFinishVoice: () => void;
  onInputFocus: () => void;
  onPickImage: (source: 'picker' | 'camera') => void;
  onReleaseVoice: () => void;
  onRequestFinishVoice: () => void;
  onSaveMusicCookie: (testAfterSave: boolean) => void;
  onSend: () => void;
  onStartVoice: () => void;
  onStop: () => void;
  onToggleMorePanel: () => void;
  onToggleMusicConnection: () => void;
  onToggleMusicSettings: () => void;
  onToggleVoiceMode: () => void;
  replyingToMessage: SubjectiveMessage | null;
  replyBusy: boolean;
  sendBlocked: boolean;
  sendActsAsStop: boolean;
  voiceBlocked: boolean;
  voiceBusy: boolean;
  voiceCancelAvailable: boolean;
  voiceCaptureActive: boolean;
  voiceMode: boolean;
  voiceRecordStartedAt: number | null;
  voiceRecordingVisible: boolean;
  voiceSendAvailable: boolean;
  voiceStarting: boolean;
  waitingModeEnabled: boolean;
};

export function ChatComposer({
  readingReference,
  onRemoveReadingReference,
  configLoaded,
  configured,
  draftText,
  draftResetVersion,
  imageSending,
  inputRef,
  memoryNotice,
  morePanelNotice,
  morePanelOpen,
  musicAutoplay,
  musicConnectionOpen,
  musicCookieBusy,
  musicCookieDraft,
  musicCookieSaved,
  musicEnabled,
  musicMultipleCardsEnabled,
  musicSettingsOpen,
  notebookTitle,
  onCancelNotebook,
  onCancelReply,
  onCancelVoice,
  onChangeDraft,
  onChangeMusicAutoplay,
  onChangeMusicCookie,
  onChangeMusicEnabled,
  onChangeMusicMultipleCards,
  onChangeWaitingMode,
  onFinishVoice,
  onInputFocus,
  onPickImage,
  onReleaseVoice,
  onRequestFinishVoice,
  onSaveMusicCookie,
  onSend,
  onStartVoice,
  onStop,
  onToggleMorePanel,
  onToggleMusicConnection,
  onToggleMusicSettings,
  onToggleVoiceMode,
  replyingToMessage,
  replyBusy,
  sendBlocked,
  sendActsAsStop,
  voiceBlocked,
  voiceBusy,
  voiceCancelAvailable,
  voiceCaptureActive,
  voiceMode,
  voiceRecordStartedAt,
  voiceRecordingVisible,
  voiceSendAvailable,
  voiceStarting,
  waitingModeEnabled,
}: ChatComposerProps) {
  const [text, setText] = useState(draftText);
  const [hasDraft, setHasDraft] = useState(!!draftText.trim());
  const hasDraftRef = useRef(!!draftText.trim());
  const effectiveSendActsAsStop = sendActsAsStop && !hasDraft;

  useEffect(() => {
    setText(draftText);
    hasDraftRef.current = !!draftText.trim();
    setHasDraft(hasDraftRef.current);
  }, [draftResetVersion, draftText]);

  const handleDraftChange = (value: string) => {
    setText(value);
    const nextHasDraft = !!value.trim();
    if (hasDraftRef.current !== nextHasDraft) {
      hasDraftRef.current = nextHasDraft;
      setHasDraft(nextHasDraft);
    }
    onChangeDraft(value);
  };

  return (
    <>
      {memoryNotice ? (
        <Animated.View
          entering={FadeIn.duration(120)}
          exiting={FadeOut.duration(120)}
          pointerEvents="none"
          style={styles.memoryNoticeOverlay}
        >
          <View style={styles.memoryNotice}>
            <Text style={styles.memoryNoticeText}>{memoryNotice}</Text>
          </View>
        </Animated.View>
      ) : null}
      {notebookTitle ? (
        <View style={styles.notebookInteractionNotice}>
          <View style={styles.replyComposerTextWrap}>
            <Text style={styles.notebookInteractionEyebrow}>正在翻白云小本本</Text>
            <Text numberOfLines={1} style={styles.notebookInteractionTitle}>
              {notebookTitle}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="取消翻这页小本本" hitSlop={8}
            onPress={onCancelNotebook} style={styles.replyComposerClose}>
            <Text style={styles.replyComposerCloseText}>×</Text>
          </Pressable>
        </View>
      ) : null}
      {replyingToMessage ? (
        <View style={styles.replyComposerPreview}>
          <View style={styles.replyComposerBar} />
          <View style={styles.replyComposerTextWrap}>
            <Text numberOfLines={1} style={styles.replyComposerTitle}>
              回复 {getReplyAuthorLabel(replyingToMessage.role)}
            </Text>
            <Text numberOfLines={1} style={styles.replyComposerText}>
              {compactReplyText(replyingToMessage.content, 80)}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="取消回复这条消息"
            hitSlop={8}
            onPress={onCancelReply}
            style={styles.replyComposerClose}
          >
            <Text style={styles.replyComposerCloseText}>×</Text>
          </Pressable>
        </View>
      ) : null}
      {readingReference ? <ChatReadingReferenceCard key={readingReference.readingId} reference={readingReference} onRemove={onRemoveReadingReference} /> : null}
      <View style={styles.composerRow}>
        <Pressable
          accessibilityLabel={morePanelOpen ? '关闭更多功能' : '打开更多功能'}
          onPress={onToggleMorePanel}
          style={({ pressed }) => [
            styles.moreButton,
            morePanelOpen && styles.moreButtonOpen,
            pressed && styles.moreButtonPressed,
          ]}
        >
          <Text style={[styles.moreButtonText, morePanelOpen && styles.moreButtonTextOpen]}>
            {morePanelOpen ? '×' : '+'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={voiceCancelAvailable ? '取消当前语音' : voiceMode ? '切换到文字输入' : '切换到语音输入'}
          disabled={false}
          hitSlop={10}
          onTouchStart={() => {
            if (voiceCancelAvailable) onCancelVoice();
          }}
          onPressIn={() => {
            if (voiceCancelAvailable) onCancelVoice();
          }}
          onPress={() => {
            if (voiceCancelAvailable) return;
            onToggleVoiceMode();
          }}
          style={({ pressed }) => [
            styles.voiceModeButton,
            voiceMode && styles.voiceModeButtonActive,
            voiceCancelAvailable && styles.voiceModeCancelButton,
            pressed && styles.sendButtonPressed,
          ]}
        >
          <Text style={[
            styles.voiceModeButtonText,
            voiceMode && styles.voiceModeButtonTextActive,
            voiceCancelAvailable && styles.voiceModeCancelText,
          ]}>
            {voiceCancelAvailable ? '×' : voiceMode ? '⌨' : '录'}
          </Text>
        </Pressable>
        <View style={styles.inputBar}>
          {voiceMode && !hasDraft ? (
            <Pressable
              accessibilityLabel={voiceCaptureActive ? '松开发送语音' : '按住开始录音'}
              disabled={!configLoaded || sendBlocked || voiceBlocked || (!voiceCaptureActive && voiceBusy) || replyBusy}
              hitSlop={8}
              onPressIn={() => {
                if (voiceCaptureActive) return;
                onStartVoice();
              }}
              onPressOut={onReleaseVoice}
              onPress={() => {
                return;
              }}
              style={({ pressed }) => [
                styles.voiceHoldButton,
                (pressed || voiceCaptureActive) && styles.voiceHoldButtonRecording,
                (!configLoaded || voiceBlocked || (!voiceCaptureActive && voiceBusy) || replyBusy) && styles.voiceHoldButtonDisabled,
              ]}
            >
              <VoiceHoldLabel
                blocked={voiceBlocked}
                busy={voiceBusy}
                recording={voiceRecordingVisible}
                recordingTextStyle={styles.voiceHoldTextRecording}
                startedAt={voiceRecordStartedAt}
                starting={voiceStarting}
                textStyle={styles.voiceHoldText}
              />
            </Pressable>
          ) : (
            <ChatTextInput
              editable={configLoaded}
              onChangeText={handleDraftChange}
              onFocus={onInputFocus}
              placeholder={configured ? '输入消息...' : '请先完成白云与连接'}
              ref={inputRef}
              testID="junluo-chat-draft-input"
              value={text}
            />
          )}
        </View>
        <ChatTextAction
          accessibilityLabel={effectiveSendActsAsStop ? '停止生成' : '发送消息'}
          disabled={!effectiveSendActsAsStop && (sendBlocked || (!voiceSendAvailable && (!hasDraft || !configLoaded)))}
          stops={effectiveSendActsAsStop}
          onTouchStart={() => {
            if (voiceSendAvailable) onRequestFinishVoice();
          }}
          onPressIn={() => {
            if (voiceSendAvailable) onRequestFinishVoice();
          }}
          onPress={effectiveSendActsAsStop ? onStop : voiceSendAvailable ? onFinishVoice : onSend}
        />
      </View>
      {morePanelOpen ? (
        <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(130)} style={styles.morePanelFrame}>
          <ScrollView
            contentContainerStyle={styles.morePanel}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Pressable
              accessibilityLabel="选图发送"
              disabled={imageSending || sendBlocked}
              onPress={() => onPickImage('picker')}
              style={({ pressed }) => [styles.moreGridItem, pressed && styles.moreGridItemPressed]}
            >
              <View style={styles.moreGridIcon}>
                <Text style={styles.moreGridIconText}>图</Text>
              </View>
              <Text style={styles.moreGridLabel}>选图发送</Text>
              <Text style={styles.moreGridStatus}>{imageSending ? '处理中' : '相册'}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="拍照发送"
              disabled={imageSending || sendBlocked}
              onPress={() => onPickImage('camera')}
              style={({ pressed }) => [styles.moreGridItem, pressed && styles.moreGridItemPressed]}
            >
              <View style={styles.moreGridIcon}>
                <Text style={styles.moreGridIconText}>拍</Text>
              </View>
              <Text style={styles.moreGridLabel}>拍照发送</Text>
              <Text style={styles.moreGridStatus}>{imageSending ? '处理中' : '相机'}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: waitingModeEnabled }}
              onPress={() => onChangeWaitingMode(!waitingModeEnabled)}
              style={({ pressed }) => [styles.moreGridItem, pressed && styles.moreGridItemPressed]}
            >
              <View style={[styles.moreGridIcon, waitingModeEnabled && styles.moreGridIconActive]}>
                <Text style={[styles.moreGridIconText, waitingModeEnabled && styles.moreGridIconTextActive]}>候</Text>
                <View style={[styles.moreGridSwitch, waitingModeEnabled && styles.moreGridSwitchActive]}>
                  <View style={[styles.moreGridSwitchThumb, waitingModeEnabled && styles.moreGridSwitchThumbActive]} />
                </View>
              </View>
              <Text style={styles.moreGridLabel}>等待模式</Text>
              <Text style={styles.moreGridStatus}>{waitingModeEnabled ? '已开启' : '已关闭'}</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="音乐点歌设置"
              onPress={onToggleMusicSettings}
              style={({ pressed }) => [styles.moreGridItem, pressed && styles.moreGridItemPressed]}
            >
              <View style={[styles.moreGridIcon, musicEnabled && styles.musicGridIconActive]}>
                <Text style={[styles.moreGridIconText, musicEnabled && styles.musicGridIconTextActive]}>乐</Text>
                <View style={[styles.moreGridSwitch, musicEnabled && styles.musicGridSwitchActive]}>
                  <View style={[styles.moreGridSwitchThumb, musicEnabled && styles.moreGridSwitchThumbActive]} />
                </View>
              </View>
              <Text style={styles.moreGridLabel}>音乐点歌</Text>
              <Text style={styles.moreGridStatus}>{musicEnabled ? '已开启' : '已关闭'}</Text>
            </Pressable>
            {musicSettingsOpen ? (
              <View style={styles.musicSettingsCard}>
                <View style={styles.musicSettingRow}>
                  <View style={styles.musicSettingText}>
                    <Text style={styles.musicSettingTitle}>允许白云小姐点歌</Text>
                    <Text style={styles.musicSettingDescription}>明确想听歌或气氛合适时，我可以偶尔送来一首。</Text>
                  </View>
                  <Switch
                    onValueChange={onChangeMusicEnabled}
                    thumbColor="#FFFFFF"
                    trackColor={{ false: '#DCE3E7', true: '#E7A89A' }}
                    value={musicEnabled}
                  />
                </View>
                <View style={styles.musicSettingDivider} />
                <View style={styles.musicSettingRow}>
                  <View style={styles.musicSettingText}>
                    <Text style={styles.musicSettingTitle}>自动播放</Text>
                    <Text style={styles.musicSettingDescription}>关闭时只显示歌曲卡片，由小仓鼠决定什么时候播放。</Text>
                  </View>
                  <Switch
                    disabled={!musicEnabled}
                    onValueChange={onChangeMusicAutoplay}
                    thumbColor="#FFFFFF"
                    trackColor={{ false: '#DCE3E7', true: '#E7A89A' }}
                    value={musicAutoplay}
                  />
                </View>
                <View style={styles.musicSettingDivider} />
                <View style={styles.musicSettingRow}>
                  <View style={styles.musicSettingText}>
                    <Text style={styles.musicSettingTitle}>多首音乐卡</Text>
                    <Text style={styles.musicSettingDescription}>关闭时每次只递来一首，适合需要立刻被音乐接住的时候。</Text>
                  </View>
                  <Switch
                    disabled={!musicEnabled}
                    onValueChange={onChangeMusicMultipleCards}
                    thumbColor="#FFFFFF"
                    trackColor={{ false: '#DCE3E7', true: '#E7A89A' }}
                    value={musicMultipleCardsEnabled}
                  />
                </View>
                <Pressable onPress={onToggleMusicConnection} style={styles.musicConnectionToggle}>
                  <Text style={styles.musicConnectionToggleText}>网易云登录（可选）</Text>
                  <Text style={styles.musicConnectionChevron}>{musicConnectionOpen ? '⌃' : '⌄'}</Text>
                </Pressable>
                {musicConnectionOpen ? (
                  <View style={styles.musicConnectionBody}>
                    <Text style={styles.musicConnectionHint}>
                      不填写也能匿名播放免费歌曲。粘贴 MUSIC_U 或整段网易云 Cookie 后，可以使用账号已有的播放权限。
                    </Text>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={onChangeMusicCookie}
                      placeholder={musicCookieSaved ? '已保存，输入新值可替换' : 'MUSIC_U=...'}
                      placeholderTextColor="#A9B2B8"
                      secureTextEntry
                      style={styles.musicBackendInput}
                      value={musicCookieDraft}
                    />
                    <View style={styles.musicBackendActions}>
                      <Pressable
                        disabled={musicCookieBusy}
                        onPress={() => onSaveMusicCookie(false)}
                        style={styles.musicBackendButton}
                      >
                        <Text style={styles.musicBackendButtonText}>
                          {musicCookieDraft.trim() ? '保存登录' : '使用匿名'}
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={musicCookieBusy}
                        onPress={() => onSaveMusicCookie(true)}
                        style={[styles.musicBackendButton, styles.musicBackendTestButton]}
                      >
                        <Text style={styles.musicBackendButtonText}>{musicCookieBusy ? '测试中...' : '保存并测试'}</Text>
                      </Pressable>
                    </View>
                    <Text style={styles.musicCookieHint}>
                      MUSIC_U 保存在君落的私有密钥存储中，不进入普通备份或普通业务 JSON。请单独妥善保存；清空输入后点“使用匿名”即可删除。
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {morePanelNotice ? <Text style={styles.morePanelNotice}>{morePanelNotice}</Text> : null}
          </ScrollView>
        </Animated.View>
      ) : null}
    </>
  );
}

import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../components/AppText';
import { styles as chatStyles } from '../screens/ChatScreen.styles';
import { colors } from '../theme/colors';
import { TheaterComposer, type TheaterComposerProps } from './TheaterComposer';
import type { TheaterTextVersion } from './theaterStoryTypes';
import type { ReactNode } from 'react';
import { TheaterReadingList, type TheaterReadingProps } from './TheaterReadingList';

type Props = TheaterComposerProps & TheaterReadingProps & {
  loaded?: boolean;
  messages: TheaterTextVersion[];
  names: { I: string; you: string };
  renderMessage?: (message: TheaterTextVersion, index: number) => ReactNode;
};

// Unmounted candidate. The host keeps its sky, drawer, header, tabs and keyboard avoidance.
// Only adopted, ordered versions belong here; preview/edit buffers remain outside the composer.
export function TheaterConversationPanel({ messages, names, renderMessage, reading, readingActive, jump, onJumpHandled, displayedVersionId, loaded = true, ...composer }: Props) {
  const insets = useSafeAreaInsets();
  const dialogues = messages.filter(message => message.kind === 'dialogue');
  return (
    <View style={[styles.root, { paddingLeft: Math.max(12, insets.left), paddingRight: Math.max(12, insets.right) }]}>
      {reading ? <TheaterReadingList key={JSON.stringify([composer.storyId, composer.branchId])}
        reading={reading} readingActive={readingActive} jump={jump} onJumpHandled={onJumpHandled} loaded={loaded}
        displayedVersionId={displayedVersionId}
        binding={{ storyId: composer.storyId, branchId: composer.branchId }}
        messages={dialogues} names={names} renderMessage={renderMessage} /> : <FlatList
        data={dialogues}
        keyExtractor={(message) => message.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.messages}
        renderItem={({ item, index }) => {
          if (item.kind !== 'dialogue') return null;
          const right = item.subject === 'you';
          const previous = dialogues[index - 1];
          const showName = previous?.kind !== 'dialogue' || previous.subject !== item.subject;
          return (
            <View style={[styles.row, right && styles.right]}>
              {showName ? <Text style={chatStyles.messageName}>{names[item.subject]}</Text> : null}
              {renderMessage ? renderMessage(item, index) : <View style={[styles.bubble, right ? chatStyles.youBubble : chatStyles.iBubble]}>
                <Text selectable style={styles.body}>{item.content}</Text>
              </View>}
            </View>
          );
        }}
      />}
      <View style={{ paddingBottom: Math.max(10, insets.bottom), paddingTop: 8 }}>
        <TheaterComposer {...composer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  messages: { paddingVertical: 12, gap: 10 },
  row: { alignItems: 'flex-start', gap: 4 },
  right: { alignItems: 'flex-end' },
  bubble: { maxWidth: '92%' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 23 },
});

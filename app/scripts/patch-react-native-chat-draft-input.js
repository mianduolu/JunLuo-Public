const fs = require('fs');
const path = require('path');

const textInputTarget = path.join(
  __dirname,
  '..',
  'node_modules',
  'react-native',
  'Libraries',
  'Components',
  'TextInput',
  'TextInput.js',
);

function replaceExactlyOnce(source, label, before, after) {
  if (source.includes(after)) return { source, changed: false };
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected one React Native ${label} block, found ${matches}.`);
  }
  return { source: source.replace(before, after), changed: true };
}

function patchTextInput() {
  let source = fs.readFileSync(textInputTarget, 'utf8');
  let changed = false;

  const stateBefore = [
    '  const [mostRecentEventCount, setMostRecentEventCount] = useState<number>(0);',
    '  const {setLastNativeText, setLastNativeSelection} =',
  ].join('\n');
  const stateAfter = [
    '  const [mostRecentEventCount, setMostRecentEventCount] = useState<number>(0);',
    '  const mostRecentEventCountRef = useRef<number>(0);',
    '  const isJunLuoUncontrolledDraft =',
    "    props.testID === 'junluo-chat-draft-input' &&",
    "    typeof props.value !== 'string' &&",
    '    selection == null;',
    '  const {setLastNativeText, setLastNativeSelection} =',
  ].join('\n');
  ({ source, changed: stateChanged } = replaceExactlyOnce(
    source,
    'chat draft state marker',
    stateBefore,
    stateAfter,
  ));
  changed ||= stateChanged;

  const clearBefore = [
    '              viewCommands.setTextAndSelection(',
    '                inputRef.current,',
    '                mostRecentEventCount,',
    "                '',",
  ].join('\n');
  const clearAfter = [
    '              viewCommands.setTextAndSelection(',
    '                inputRef.current,',
    '                mostRecentEventCountRef.current,',
    "                '',",
  ].join('\n');
  ({ source, changed: clearChanged } = replaceExactlyOnce(
    source,
    'imperative clear event count',
    clearBefore,
    clearAfter,
  ));
  changed ||= clearChanged;

  const selectionCommandBefore = [
    '              viewCommands.setTextAndSelection(',
    '                inputRef.current,',
    '                mostRecentEventCount,',
    '                null,',
  ].join('\n');
  const selectionCommandAfter = [
    '              viewCommands.setTextAndSelection(',
    '                inputRef.current,',
    '                mostRecentEventCountRef.current,',
    '                null,',
  ].join('\n');
  ({ source, changed: selectionCommandChanged } = replaceExactlyOnce(
    source,
    'imperative selection event count',
    selectionCommandBefore,
    selectionCommandAfter,
  ));
  changed ||= selectionCommandChanged;

  const refDependenciesBefore = '    [mostRecentEventCount, viewCommands],';
  const refDependenciesAfter = '    [viewCommands],';
  ({ source, changed: refDependenciesChanged } = replaceExactlyOnce(
    source,
    'stable imperative ref dependencies',
    refDependenciesBefore,
    refDependenciesAfter,
  ));
  changed ||= refDependenciesChanged;

  const changeBefore = [
    '    setLastNativeText(currentText);',
    '    // This must happen last, after we call setLastNativeText.',
    '    // Different ordering can cause bugs when editing AndroidTextInputs',
    '    // with multiple Fragments.',
    '    // We must update this so that controlled input updates work.',
    '    setMostRecentEventCount(event.nativeEvent.eventCount);',
  ].join('\n');
  const changeAfter = [
    '    mostRecentEventCountRef.current = event.nativeEvent.eventCount;',
    '    if (!isJunLuoUncontrolledDraft) {',
    '      setLastNativeText(currentText);',
    '      // This must happen last, after we call setLastNativeText.',
    '      // Different ordering can cause bugs when editing AndroidTextInputs',
    '      // with multiple Fragments.',
    '      // We must update this so that controlled input updates work.',
    '      setMostRecentEventCount(event.nativeEvent.eventCount);',
    '    }',
  ].join('\n');
  ({ source, changed: changeChanged } = replaceExactlyOnce(
    source,
    'uncontrolled draft change guard',
    changeBefore,
    changeAfter,
  ));
  changed ||= changeChanged;

  const selectionBefore = [
    '    setLastNativeSelection({',
    '      selection: event.nativeEvent.selection,',
    '      mostRecentEventCount,',
    '    });',
  ].join('\n');
  const selectionAfter = [
    '    if (!isJunLuoUncontrolledDraft) {',
    '      setLastNativeSelection({',
    '        selection: event.nativeEvent.selection,',
    '        mostRecentEventCount,',
    '      });',
    '    }',
  ].join('\n');
  ({ source, changed: selectionChanged } = replaceExactlyOnce(
    source,
    'uncontrolled draft selection guard',
    selectionBefore,
    selectionAfter,
  ));
  changed ||= selectionChanged;

  if (changed) fs.writeFileSync(textInputTarget, source);
  return changed;
}

const textInputChanged = patchTextInput();
if (textInputChanged) {
  console.log('Applied React Native chat draft JS hot-path guard.');
} else {
  console.log('React Native chat draft JS hot-path guard is already applied.');
}

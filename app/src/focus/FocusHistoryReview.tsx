import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { AiConnection } from '../ai/types';
import { AppText as Text } from '../components/AppText';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { FocusJournalEntry, focusJournalPalette } from './FocusJournal';
import { FocusSummarySection } from './FocusSummarySection';
import { isFocusOrganizationLog } from './focusSummaryRecord';
import { isFocusGenerationFailureResolved } from './focusChatDelivery';
import { isFocusSleepReplyReceipt } from './focusSleepReplyPolicy';
import { loadFocusHistoryYears, loadFocusLogs, loadFocusSessionById, loadFocusSessionsInRange, type FocusSession, type FocusLogEntry } from './focusStore';
import { focusDayStart, focusRangeMilliseconds, focusSceneMilliseconds, focusShares,
  focusWeekStart, focusMonthStart, focusMonthDays, focusYearStart, formatFocusTime,
  shiftFocusDay, shiftFocusMonth, shiftFocusYear, type FocusShare } from './focusReviewData';

const clock = (value: number) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const dateLabel = (value: number) => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
type ReviewView = 'day' | 'week' | 'month' | 'year';
type ParentPeriod = { view: 'month' | 'year'; date: number };
const viewNames = { day: '日', week: '周', month: '月', year: '年' } as const;

function TotalDuration({ milliseconds }: { milliseconds: number }) {
  const seconds = Math.floor(milliseconds / 1000); const minutes = Math.floor(seconds / 60);
  return <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.88}>
    {minutes >= 60 ? <>{Math.floor(minutes / 60)}<Text style={styles.totalUnit}> 小时 </Text>{minutes % 60}<Text style={styles.totalUnit}> 分钟</Text></>
      : seconds >= 60 || seconds === 0 ? <>{minutes}<Text style={styles.totalUnit}> 分钟</Text></>
        : <>{seconds}<Text style={styles.totalUnit}> 秒</Text></>}
  </Text>;
}

function FocusPie({ entries }: { entries: FocusShare[] }) {
  const total = entries.reduce((sum, entry) => sum + entry.milliseconds, 0);
  let angle = -Math.PI / 2;
  return <Svg width={106} height={106} viewBox="0 0 106 106" accessible={false}>
    {entries.map(entry => {
      const next = angle + entry.milliseconds / total * Math.PI * 2;
      const path = `M 53 53 L ${53 + 53 * Math.cos(angle)} ${53 + 53 * Math.sin(angle)} A 53 53 0 ${next - angle > Math.PI ? 1 : 0} 1 ${53 + 53 * Math.cos(next)} ${53 + 53 * Math.sin(next)} Z`;
      angle = next;
      return entry.milliseconds === total ? <Path key={entry.id} d="M 53 0 A 53 53 0 1 1 53 106 A 53 53 0 1 1 53 0 Z" fill={entry.color} />
        : <Path key={entry.id} d={path} fill={entry.color} />;
    })}
  </Svg>;
}

export function FocusHistoryReview({ active, apiKey, connection }: {
  active: boolean; apiKey: string; connection?: AiConnection | null;
}) {
  const [view, setView] = useState<ReviewView>('day');
  const [date, setDate] = useState(() => focusDayStart(Date.now()));
  const [parents, setParents] = useState<ParentPeriod[]>([]);
  const [scenes, setScenes] = useState<FocusSession[]>([]);
  const [detail, setDetail] = useState<{ session: FocusSession; logs: FocusLogEntry[] } | null>(null);
  const [shareView, setShareView] = useState<'overview' | 'category'>('overview');
  const [categoryId, setCategoryId] = useState('required-study');
  const [picker, setPicker] = useState(false);
  const [periodPicker, setPeriodPicker] = useState<{ view: 'month' | 'year'; year: number; month: number } | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [yearsBusy, setYearsBusy] = useState(false);
  const [yearsNotice, setYearsNotice] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const live = useRef(false);
  const request = useRef(0);
  const pickerRequest = useRef(0);
  const epoch = useRef<number | null>(null);
  const locked = useRef(false);
  const from = view === 'year' ? focusYearStart(date) : view === 'month' ? focusMonthStart(date)
    : view === 'week' ? focusWeekStart(date) : date;
  const to = view === 'year' ? shiftFocusYear(from, 1) : view === 'month' ? shiftFocusMonth(from, 1)
    : shiftFocusDay(from, view === 'week' ? 7 : 1);
  const read = async () => {
    const serial = ++request.current;
    const captured = captureBackupRestoreDataEpoch();
    setBusy(true); setScenes([]); setDetail(null);
    try {
      const records = await loadFocusSessionsInRange(from, to);
      if (!live.current || serial !== request.current || !canCommitBackupRestoreDataEpoch(captured)) return;
      setScenes(records); epoch.current = captured; setNotice('');
    } catch { if (live.current && serial === request.current) setNotice('记录暂未读取成功，请重试。'); }
    finally { if (live.current && serial === request.current) setBusy(false); }
  };
  useEffect(() => {
    live.current = true; if (active) void read();
    return () => { live.current = false; request.current += 1; pickerRequest.current += 1; };
  }, [active, from, to]);
  const closePeriodPicker = () => { pickerRequest.current += 1; setPeriodPicker(null); setYearsBusy(false); };
  const choosePeriod = (nextView: ReviewView, nextDate = date) => {
    closePeriodPicker(); setPicker(false); setParents([]); setDate(nextDate); setView(nextView);
  };
  const drill = (nextView: 'month' | 'day', nextDate: number) => {
    if (view === 'month' || view === 'year') setParents(previous => [...previous, { view, date }]);
    setDate(nextDate); setView(nextView);
  };
  const returnToParent = () => {
    const parent = parents.at(-1);
    if (parent) { setParents(previous => previous.slice(0, -1)); setDate(parent.date); setView(parent.view); }
  };
  const shiftPeriod = (amount: number) => choosePeriod(view, view === 'year' ? shiftFocusYear(date, amount)
    : view === 'month' ? shiftFocusMonth(date, amount) : shiftFocusDay(date, amount * (view === 'week' ? 7 : 1)));
  const openPeriodPicker = async () => {
    if (view !== 'month' && view !== 'year') return;
    const serial = ++pickerRequest.current, rangeSerial = request.current;
    const captured = captureBackupRestoreDataEpoch();
    setPeriodPicker({ view, year: new Date(date).getFullYear(), month: new Date(date).getMonth() });
    setYears([]); setYearsNotice(''); setYearsBusy(true);
    try {
      const available = await loadFocusHistoryYears();
      if (!live.current || serial !== pickerRequest.current || rangeSerial !== request.current) return;
      if (!canCommitBackupRestoreDataEpoch(captured)) throw new Error('FOCUS_DATA_CHANGED');
      setYears(available);
    } catch {
      if (live.current && serial === pickerRequest.current && rangeSerial === request.current)
        setYearsNotice('历史年份暂未读取成功，请重试。');
    } finally {
      if (live.current && serial === pickerRequest.current && rangeSerial === request.current) setYearsBusy(false);
    }
  };
  const confirmPeriod = () => {
    if (!periodPicker || yearsBusy || yearsNotice) return;
    const selected = new Date(periodPicker.year, periodPicker.view === 'month' ? periodPicker.month : 0, 1).getTime();
    const end = periodPicker.view === 'month' ? shiftFocusMonth(selected, 1) : shiftFocusYear(selected, 1);
    choosePeriod(periodPicker.view, selected);
    // The same selected period does not trigger the range effect; refresh it after a picker retry/restore too.
    if (selected === from && end === to) void read();
  };
  const open = async (id: string) => {
    if (locked.current || busy) return;
    locked.current = true; setBusy(true);
    const captured = epoch.current; const serial = request.current;
    try {
      if (!canCommitBackupRestoreDataEpoch(captured)) throw new Error('FOCUS_DATA_CHANGED');
      const session = await loadFocusSessionById(id);
      const logs = await loadFocusLogs(id);
      if (!session) throw new Error('FOCUS_SOURCE_DELETED');
      if (live.current && serial === request.current && canCommitBackupRestoreDataEpoch(captured)) setDetail({ session, logs });
    } catch { if (live.current && serial === request.current) setNotice('这条记录已变化，请重新读取。'); }
    finally { locked.current = false; if (live.current && serial === request.current) setBusy(false); }
  };
  const overview = focusShares(scenes, from, to);
  const selectedCategory = overview.find(entry => entry.id === categoryId) ?? overview[0];
  const shares = shareView === 'category' && selectedCategory
    ? focusShares(scenes, from, to, selectedCategory.id) : overview;
  const total = scenes.reduce((sum, scene) => sum + focusRangeMilliseconds(scene, from, to), 0);
  const legacy = scenes.filter(scene => !scene.review && scene.startedAt >= from && scene.startedAt < to);
  const daily = Array.from({ length: 7 }, (_, index) => {
    const day = shiftFocusDay(from, index); const end = shiftFocusDay(day, 1);
    return { day, milliseconds: scenes.reduce((sum, scene) => sum + focusRangeMilliseconds(scene, day, end), 0) };
  });
  const maxDay = Math.max(1, ...daily.map(day => day.milliseconds));
  const monthDays = view === 'month' ? focusMonthDays(from).map(day => ({ day,
    milliseconds: scenes.reduce((sum, scene) => sum + focusRangeMilliseconds(scene, day, shiftFocusDay(day, 1)), 0),
    old: legacy.some(scene => scene.startedAt >= day && scene.startedAt < shiftFocusDay(day, 1)),
  })) : [];
  const monthOffset = (new Date(from).getDay() + 6) % 7;
  const monthCells = view === 'month' ? [
    ...Array.from({ length: monthOffset }, () => null), ...monthDays,
    ...Array.from({ length: (7 - (monthOffset + monthDays.length) % 7) % 7 }, () => null),
  ] : [];
  const maxMonthDay = Math.max(1, ...monthDays.map(day => day.milliseconds));
  const months = view === 'year' ? Array.from({ length: 12 }, (_, index) => {
    const month = shiftFocusMonth(from, index);
    return { month, milliseconds: scenes.reduce((sum, scene) => sum + focusRangeMilliseconds(scene, month, shiftFocusMonth(month, 1)), 0) };
  }) : [];
  const maxMonth = Math.max(1, ...months.map(month => month.milliseconds));
  const availableYears = [...new Set([...years, new Date(Date.now()).getFullYear(), periodPicker?.year ?? new Date(date).getFullYear()])]
    .sort((a, b) => b - a);
  const dayScenes = scenes.filter(scene => scene.review && (focusRangeMilliseconds(scene, from, to) > 0
    || scene.review.spans.length === 0 && scene.startedAt >= from && scene.startedAt < to));
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    {notice ? <Pressable accessibilityRole="button" onPress={() => void read()} style={styles.paper}>
      <Text style={styles.muted}>{notice}</Text><Text style={styles.link}>重新读取</Text>
    </Pressable> : null}
    {detail ? <>
      <Pressable accessibilityRole="button" onPress={() => setDetail(null)} style={styles.back}><Text style={styles.muted}>‹ 返回回顾</Text></Pressable>
      <View style={styles.paper}>
        <Text style={styles.detailTitle}>{detail.session.userActivity}</Text>
        <Text style={styles.meta}>{dateLabel(detail.session.startedAt)} {clock(detail.session.startedAt)} → {dateLabel(detail.session.endedAt)} {clock(detail.session.endedAt)}</Text>
        <Text style={styles.meta}>{detail.session.review ? '本场时长' : '原记录时长'} · {formatFocusTime(focusSceneMilliseconds(detail.session) ?? detail.session.durationSeconds * 1000)}</Text>
      </View>
      <FocusSummarySection sessionId={detail.session.id} apiKey={apiKey} connection={connection} active={active} autoOrganize={false} />
      <View style={[styles.paper, { marginTop: 18 }]}>
        <Text style={styles.sectionTitle}>日志</Text>
        {detail.logs.filter(log => !isFocusOrganizationLog(log) && !isFocusSleepReplyReceipt(log)
          && !isFocusGenerationFailureResolved(log, detail.logs)).map(log =>
          <FocusJournalEntry key={log.id} log={log} showDate />)}
        {!detail.logs.length ? <Text style={styles.empty}>这条记录没有日志。</Text> : null}
      </View>
    </> : <>
      {parents.length ? <Pressable accessibilityRole="button" onPress={returnToParent} style={styles.back}>
        <Text style={styles.muted}>{parents.at(-1)?.view === 'year' ? '‹ 返回年回顾' : '‹ 返回月回顾'}</Text>
      </Pressable> : null}
      <View style={styles.tabs}>{(['day', 'week', 'month', 'year'] as const).map(item => <Pressable key={item} accessibilityRole="button"
        accessibilityState={{ selected: item === view }} onPress={() => choosePeriod(item)} style={[styles.tab, item === view && styles.selected]}>
        <Text style={styles.ink}>{viewNames[item]}</Text></Pressable>)}</View>
      <View style={styles.period}>
        <Pressable accessibilityRole="button" accessibilityLabel={`上一${view === 'day' ? '天' : viewNames[view]}`} style={styles.arrow}
          onPress={() => shiftPeriod(-1)}><Text style={styles.arrowText}>‹</Text></Pressable>
        {view === 'month' || view === 'year' ? <Pressable accessibilityRole="button" accessibilityLabel={view === 'month' ? '选择年月' : '选择年份'}
          style={styles.periodTitle} onPress={() => void openPeriodPicker()}>
          <Text style={[styles.periodText, styles.periodTitleText]}>{new Date(from).getFullYear()}年{view === 'month' ? `${new Date(from).getMonth() + 1}月` : ''} ▾</Text>
        </Pressable> : <Text style={styles.periodText}>{view === 'day' ? `${dateLabel(from)} · 周${'日一二三四五六'[new Date(from).getDay()]}` : `${dateLabel(from)} — ${new Date(shiftFocusDay(to, -1)).getMonth() + 1}月${new Date(shiftFocusDay(to, -1)).getDate()}日`}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`下一${view === 'day' ? '天' : viewNames[view]}`} style={styles.arrow}
          onPress={() => shiftPeriod(1)}><Text style={styles.arrowText}>›</Text></Pressable>
      </View>
      <View style={styles.paper}>
        <Text style={styles.muted}>{view === 'day' ? '当天时长' : view === 'week' ? '本周时长' : view === 'month' ? '本月时长' : '本年时长'}</Text>
        <TotalDuration milliseconds={total} /><View style={styles.divider} />
        {busy ? <Text style={styles.empty}>正在读取记录…</Text> : view === 'week' ? <>
          <View style={styles.chartCaption}><Text style={styles.muted}>每日时长</Text><Text style={styles.muted}>分钟</Text></View>
          <View style={styles.chart}>
          {daily.map((day, index) => <Pressable key={day.day} accessibilityRole="button" style={styles.barButton}
            accessibilityLabel={`周${'一二三四五六日'[index]}，${formatFocusTime(day.milliseconds)}，查看当日`}
            onPress={() => { setDate(day.day); setView('day'); }}>
            <View style={styles.barZone}><Text style={styles.barValue}>{Math.floor(day.milliseconds / 60000)}</Text>
              <View style={[styles.bar, { height: day.milliseconds ? Math.max(5, day.milliseconds / maxDay * 136) : 3,
                backgroundColor: day.milliseconds ? '#B2D9FF' : '#E8EDF0' }]} /></View>
            <Text style={styles.weekday}>{'一二三四五六日'[index]}</Text>
            <Text style={styles.barValue}>{new Date(day.day).getMonth() + 1}/{new Date(day.day).getDate()}</Text>
          </Pressable>)}
        </View></> : view === 'month' ? <>
          <View style={styles.chartCaption}><Text style={styles.muted}>每日时长</Text><Text style={styles.muted}>分钟</Text></View>
          <View style={styles.calendarRow}>{[...'一二三四五六日'].map(label => <Text key={label} style={styles.calendarWeekday}>{label}</Text>)}</View>
          {Array.from({ length: monthCells.length / 7 }, (_, row) => <View key={row} style={styles.calendarRow}>
            {monthCells.slice(row * 7, row * 7 + 7).map((cell, column) => cell ? <Pressable key={cell.day} accessibilityRole="button"
              accessibilityLabel={`${dateLabel(cell.day)}，${cell.milliseconds ? formatFocusTime(cell.milliseconds) : cell.old ? '只有旧记录' : '暂无记录'}，查看当日`}
              onPress={() => drill('day', cell.day)} style={[styles.calendarCell, { backgroundColor: cell.milliseconds
                ? `rgba(178,217,255,${0.18 + cell.milliseconds / maxMonthDay * 0.48})` : 'transparent' }]}>
              <Text style={styles.calendarDate}>{new Date(cell.day).getDate()}</Text>
              <Text style={styles.calendarValue}>{cell.milliseconds ? Math.floor(cell.milliseconds / 60000) : cell.old ? '旧' : '—'}</Text>
            </Pressable> : <View key={`blank-${column}`} style={styles.calendarCell} />)}
          </View>)}
        </> : view === 'year' ? <>
          <View style={styles.chartCaption}><Text style={styles.muted}>每月时长</Text><Text style={styles.muted}>分钟</Text></View>
          {[0, 6].map(offset => <View key={offset} style={styles.yearChart}>
            {months.slice(offset, offset + 6).map((month, index) => <Pressable key={month.month} accessibilityRole="button" style={styles.barButton}
              accessibilityLabel={`${offset + index + 1}月，${formatFocusTime(month.milliseconds)}，查看本月`}
              onPress={() => drill('month', month.month)}>
              <View style={styles.yearBarZone}><Text style={styles.barValue}>{Math.floor(month.milliseconds / 60000)}</Text>
                <View style={[styles.bar, { height: month.milliseconds ? Math.max(5, month.milliseconds / maxMonth * 98) : 3,
                  backgroundColor: month.milliseconds ? '#B2D9FF' : '#E8EDF0' }]} /></View>
              <Text style={styles.yearMonth}>{offset + index + 1}月</Text>
            </Pressable>)}
          </View>)}
        </> : dayScenes.length ? <View style={styles.timeline}>
          {dayScenes.map(scene => <Pressable key={scene.id} accessibilityRole="button" disabled={busy} onPress={() => void open(scene.id)} style={styles.record}>
            <View style={styles.dot} /><Text style={styles.meta}>{clock(scene.startedAt)} — {clock(scene.endedAt)}</Text>
            <View style={styles.recordMain}><Text style={styles.task}>{scene.userActivity}</Text><Text style={styles.duration}>{formatFocusTime(focusRangeMilliseconds(scene, from, to))}</Text></View>
            {scene.startedAt < from || scene.endedAt > to ? <Text style={styles.meta}>跨日记录 · 此处仅计本日部分</Text> : null}
          </Pressable>)}
        </View> : <Text style={styles.empty}>{legacy.length ? '这天只有旧记录，原记录时长见下方。' : '这天还没有已保存的专注记录。'}</Text>}
      </View>
      {legacy.length ? <View style={styles.legacy}>
        <Text style={styles.legacyTitle}>旧记录 <Text style={styles.meta}>不计入上方合计</Text></Text>
        {legacy.map(scene => <Pressable key={scene.id} accessibilityRole="button" disabled={busy} onPress={() => void open(scene.id)} style={styles.legacyRow}>
          <Text style={styles.meta}>{view !== 'day' ? `${dateLabel(scene.startedAt)} · ` : ''}{clock(scene.startedAt)}</Text>
          <View style={styles.recordMain}><Text style={styles.task}>{scene.userActivity}</Text><Text style={styles.duration}>{formatFocusTime(scene.durationSeconds * 1000)}</Text></View>
          <Text style={styles.meta}>原记录时长</Text>
        </Pressable>)}
      </View> : null}
      <View style={[styles.paper, { marginTop: 18 }]}>
        <Text style={styles.sectionTitle}>时间占比</Text>
        <View style={styles.shareTabs}>{(['overview', 'category'] as const).map(item => <Pressable key={item} accessibilityRole="button"
          disabled={!overview.length && item === 'category'} accessibilityState={{ selected: shareView === item }}
          onPress={() => setShareView(item)} style={[styles.shareTab, shareView === item && styles.selected]}><Text style={styles.ink}>{item === 'overview' ? '总览' : '分类'}</Text></Pressable>)}</View>
        {shareView === 'category' && selectedCategory ? <View style={styles.recordMain}>
          <Pressable accessibilityRole="button" disabled={overview.length < 2} style={styles.categoryPicker} onPress={() => setPicker(true)}>
            <Text style={styles.ink}>{selectedCategory.label}{overview.length > 1 ? ' ▾' : ''}</Text></Pressable>
          <Text style={styles.meta}>{formatFocusTime(selectedCategory.milliseconds)}</Text>
        </View> : null}
        {shares.length ? <View style={styles.shareContent}>
          <FocusPie entries={shares} /><View style={styles.legend}>{shares.map(entry => <Pressable key={entry.id} accessibilityRole={shareView === 'overview' ? 'button' : 'text'}
            disabled={shareView !== 'overview'} onPress={() => { setCategoryId(entry.id); setShareView('category'); }} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: entry.color }]} />
            <View style={styles.legendText}><Text style={styles.shareName}>{entry.label}</Text><Text style={styles.meta}>{formatFocusTime(entry.milliseconds)}</Text></View>
            <Text style={styles.percent}>{entry.percent}%</Text>
          </Pressable>)}</View>
        </View> : <Text style={styles.empty}>这段时间暂无可统计的分类。</Text>}
      </View>
      <Modal visible={picker} transparent animationType="fade" onRequestClose={() => setPicker(false)}>
        <Pressable style={styles.scrim} onPress={() => setPicker(false)} accessibilityLabel="关闭分类选择">
          <View style={styles.pickerPaper}><ScrollView>{overview.map(entry => <Pressable key={entry.id} accessibilityRole="button" style={styles.option}
            onPress={() => { setCategoryId(entry.id); setPicker(false); }}><Text style={styles.ink}>{entry.label}</Text></Pressable>)}</ScrollView></View>
        </Pressable>
      </Modal>
      <Modal visible={!!periodPicker} transparent animationType="fade" onRequestClose={closePeriodPicker}>
        <View style={styles.scrim}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closePeriodPicker} accessibilityLabel="关闭年月选择" />
          <View style={styles.pickerPaper}>
            <Text style={styles.periodPickerTitle}>{periodPicker?.view === 'month' ? '选择年月' : '选择年份'}</Text>
            {yearsNotice ? <Pressable accessibilityRole="button" onPress={() => void openPeriodPicker()} style={styles.option}>
              <Text style={styles.muted}>{yearsNotice}</Text><Text style={styles.link}>重新读取年份</Text>
            </Pressable> : null}
            {yearsBusy ? <Text style={styles.muted}>正在读取年份…</Text> : null}
            <View style={styles.periodColumns}>
              <View style={styles.periodColumn}><Text style={styles.muted}>年份</Text>
                <ScrollView style={styles.periodOptions}>{availableYears.map(year => <Pressable key={year} accessibilityRole="button"
                  accessibilityLabel={`${year}年`} accessibilityState={{ selected: periodPicker?.year === year }}
                  onPress={() => setPeriodPicker(previous => previous ? { ...previous, year } : null)}
                  style={[styles.periodOption, periodPicker?.year === year && styles.selected]}><Text style={styles.ink}>{year}年</Text></Pressable>)}</ScrollView>
              </View>
              {periodPicker?.view === 'month' ? <View style={styles.periodColumn}><Text style={styles.muted}>月份</Text>
                <ScrollView style={styles.periodOptions}>{Array.from({ length: 12 }, (_, month) => <Pressable key={month} accessibilityRole="button"
                  accessibilityLabel={`${month + 1}月`} accessibilityState={{ selected: periodPicker.month === month }}
                  onPress={() => setPeriodPicker(previous => previous ? { ...previous, month } : null)}
                  style={[styles.periodOption, periodPicker.month === month && styles.selected]}><Text style={styles.ink}>{month + 1}月</Text></Pressable>)}</ScrollView>
              </View> : null}
            </View>
            <View style={styles.periodActions}>
              <Pressable accessibilityRole="button" onPress={closePeriodPicker} style={styles.periodOption}><Text style={styles.muted}>取消</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={yearsBusy || !!yearsNotice} style={[styles.periodConfirm, (yearsBusy || !!yearsNotice) && styles.disabled]}
                onPress={confirmPeriod}>
                <Text style={styles.ink}>查看</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 36 },
  paper: { padding: 18, paddingTop: 20, paddingBottom: 12, borderRadius: 24, backgroundColor: focusJournalPalette.paper },
  ink: { color: '#475D70', fontSize: 14 }, muted: { color: '#8A9BA7', fontSize: 12, lineHeight: 20 },
  meta: { color: '#8A9BA7', fontSize: 11, lineHeight: 19, marginTop: 4 },
  tabs: { flexDirection: 'row', gap: 4 }, tab: { paddingHorizontal: 22, minHeight: 44, justifyContent: 'center', borderRadius: 16 },
  selected: { backgroundColor: '#B2D9FF6B' }, period: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 18 },
  periodText: { color: '#475D70', fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'center' },
  arrow: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, arrowText: { color: '#8A9BA7', fontSize: 26 },
  total: { color: '#475D70', fontSize: 36, fontWeight: '400', marginTop: 6, lineHeight: 49 }, totalUnit: { fontSize: 14 },
  divider: { width: 28, height: 2, backgroundColor: '#E3A57A', marginTop: 19, marginBottom: 21 },
  timeline: { paddingLeft: 4 }, record: { borderLeftWidth: 1, borderLeftColor: '#D7E2E9', paddingLeft: 18, paddingBottom: 22, minHeight: 80 },
  dot: { position: 'absolute', top: 6, left: -4, width: 7, height: 7, borderRadius: 4, backgroundColor: '#80A7C5' },
  recordMain: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 7 },
  task: { color: '#475D70', fontSize: 16, fontWeight: '500', flex: 1 }, duration: { color: '#475D70', fontSize: 13, flexShrink: 0 },
  legacy: { marginTop: 19, paddingHorizontal: 5, gap: 10 }, legacyTitle: { color: '#475D70', fontSize: 13, fontWeight: '500', lineHeight: 22 },
  legacyRow: { borderRadius: 15, backgroundColor: 'rgba(253,253,252,0.6)', padding: 14 },
  empty: { color: '#8A9BA7', fontSize: 14, lineHeight: 25, paddingTop: 12, paddingBottom: 24 },
  chartCaption: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  chart: { flexDirection: 'row', gap: 2, marginHorizontal: -5 }, barButton: { flex: 1, minWidth: 0, alignItems: 'center', paddingBottom: 7 },
  barZone: { height: 186, justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingTop: 22 }, bar: { width: 22, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  barValue: { color: '#8A9BA7', fontSize: 10, marginTop: 5 }, weekday: { color: '#475D70', fontSize: 13, marginTop: 12 },
  sectionTitle: { color: '#475D70', fontSize: 16, fontWeight: '500', marginBottom: 13 },
  shareTabs: { flexDirection: 'row', gap: 5, marginBottom: 16 }, shareTab: { borderRadius: 12, minHeight: 44, justifyContent: 'center', paddingHorizontal: 15 },
  shareContent: { flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 16, marginBottom: 8 },
  legend: { flex: 1, minWidth: 0, gap: 12 }, legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  legendText: { flex: 1, minWidth: 0 }, swatch: { width: 7, height: 7, borderRadius: 4 },
  shareName: { color: '#475D70', fontSize: 13, fontWeight: '500' }, percent: { color: '#475D70', fontSize: 12 },
  categoryPicker: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#D7E2E9', borderRadius: 11, padding: 12, flexShrink: 1, minHeight: 44 },
  back: { minHeight: 44, justifyContent: 'center', marginBottom: 14 }, detailTitle: { color: '#475D70', fontSize: 22, fontWeight: '500', marginBottom: 10 },
  link: { color: '#527C9D', fontSize: 13, lineHeight: 24 }, scrim: { flex: 1, backgroundColor: 'rgba(56,64,82,0.18)', justifyContent: 'center', padding: 28 },
  pickerPaper: { backgroundColor: '#FDFDFC', borderRadius: 20, padding: 12, maxHeight: '70%' }, option: { minHeight: 44, padding: 12, justifyContent: 'center' },
  periodTitle: { flex: 1, minHeight: 44, justifyContent: 'center' }, periodTitleText: { flex: 0 },
  calendarRow: { flexDirection: 'row', gap: 2, marginTop: 3 },
  calendarWeekday: { flex: 1, textAlign: 'center', color: '#8A9BA7', fontSize: 11, lineHeight: 25 },
  calendarCell: { flex: 1, minWidth: 0, minHeight: 58, borderRadius: 10, alignItems: 'center', justifyContent: 'center', gap: 5 },
  calendarDate: { color: '#475D70', fontSize: 12 }, calendarValue: { color: '#8A9BA7', fontSize: 10 },
  yearChart: { flexDirection: 'row', gap: 2, marginHorizontal: -5, marginBottom: 14 },
  yearBarZone: { height: 148, justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingTop: 22 },
  yearMonth: { color: '#475D70', fontSize: 12, marginTop: 12 },
  periodPickerTitle: { color: '#475D70', fontSize: 16, fontWeight: '500', padding: 12 },
  periodColumns: { flexDirection: 'row', gap: 16, paddingHorizontal: 12 }, periodColumn: { flex: 1, minWidth: 0 },
  periodOptions: { maxHeight: 240, marginTop: 8 }, periodOption: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12 },
  periodActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12, padding: 12, paddingBottom: 0 },
  periodConfirm: { backgroundColor: '#B2D9FF', minHeight: 44, paddingHorizontal: 20, justifyContent: 'center', borderRadius: 12 }, disabled: { opacity: 0.5 },
});

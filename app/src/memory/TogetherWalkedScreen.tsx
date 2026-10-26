import { useEffect, useMemo, useRef, useState } from 'react';
import {
  togetherWalkedStorageBridge as AsyncStorage,
} from '../sync/syncTogetherWalkedLifeStorageBridge';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { copyFileSafely } from '../storage/safeFileWrite';
import { colors } from '../theme/colors';
import {
  assignTogetherWalkedEntries,
  createTogetherWalkedEntry,
  createTogetherWalkedJourney,
  deleteTogetherWalkedEntry,
  deleteTogetherWalkedJourney,
  loadTogetherWalkedDataStrict,
  loadTogetherWalkedEntryMemoryLink,
  retryTogetherWalkedMemory,
  TOGETHER_WALKED_DRAFT_STORAGE_KEY,
  TOGETHER_WALKED_IMAGE_FOLDER,
  updateTogetherWalkedJourney,
  type TogetherWalkedEntry,
  type TogetherWalkedJourney,
  type TogetherWalkedLocation,
  type TogetherWalkedMemorySaveResult,
} from './togetherWalkedStore';
import type { TogetherWalkedMemoryLink } from './togetherWalkedMemory';
import {
  buildTogetherWalkedJourneySummaries,
  isUsableTogetherWalkedCoordinate,
  normalizeTogetherWalkedLocation,
  type TogetherWalkedJourneySummary,
  type TogetherWalkedRoutePoint,
} from './togetherWalkedModel';

type Props = {
  onClose: () => void;
};

type ViewMode = 'journeys' | 'entries' | 'map';

type JourneyPickerTarget =
  | { kind: 'draft' }
  | { kind: 'entry'; entryId: string };

type TogetherWalkedDraft = {
  title?: string;
  note?: string;
  occurredAtText?: string;
  imageUri?: string;
  location?: TogetherWalkedLocation;
  journeyId?: string;
  manualPlace?: string;
  manualLatitude?: string;
  manualLongitude?: string;
};

type EntryMemoryState = {
  status: TogetherWalkedMemoryLink['status'] | 'checking' | 'read_failed' | 'link_pending';
  memoryIds: string[];
  memoryId?: string;
  committedMemoryId?: string;
  notice?: string;
};

const LOCATION_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOURNEY_COLORS = ['#D66F61', '#4F88A8', '#6F9D78', '#C49245', '#9A7396'];

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function formatFullDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateTimeInput(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function parseDateTimeInput(value: string) {
  const match = value.trim().match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?\s+(\d{1,2}):(\d{1,2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const timestamp = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatJourneyRange(startAt?: number, endAt?: number) {
  if (!startAt || !endAt) return '还没有脚印';
  if (new Date(startAt).toDateString() === new Date(endAt).toDateString()) return formatDate(startAt);
  return `${formatDate(startAt)} - ${formatDate(endAt)}`;
}

function hasCoordinate(location?: TogetherWalkedLocation) {
  return isUsableTogetherWalkedCoordinate(location?.latitude, location?.longitude);
}

function draftImageDirectory() {
  return FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${TOGETHER_WALKED_IMAGE_FOLDER}/drafts/` : undefined;
}

function extensionFromUri(uri: string) {
  const cleanUri = uri.split(/[?#]/)[0] ?? uri;
  const match = cleanUri.match(/\.([a-zA-Z0-9]{1,8})$/);
  return match ? match[1].toLowerCase() : 'jpg';
}

function isManagedDraftImage(uri?: string) {
  const directory = draftImageDirectory();
  if (!uri || !directory || !uri.startsWith(directory)) return false;
  const fileName = uri.slice(directory.length);
  return !!fileName
    && fileName !== '.'
    && fileName !== '..'
    && !fileName.includes('/')
    && !fileName.includes('\\')
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName);
}

async function copyDraftImageToAppStorage(sourceUri: string) {
  const directory = draftImageDirectory();
  if (!directory) throw new Error('document-directory-unavailable');
  const persistentUri = `${directory}together_walked_draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extensionFromUri(sourceUri)}`;
  await copyFileSafely({ from: sourceUri, to: persistentUri });
  return persistentUri;
}

async function deleteDraftImage(uri?: string) {
  if (isManagedDraftImage(uri)) {
    await FileSystem.deleteAsync(uri!, { idempotent: true }).catch(() => undefined);
  }
}

function normalizeDraft(value: unknown): TogetherWalkedDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as TogetherWalkedDraft;
  return {
    title: typeof draft.title === 'string' ? draft.title : undefined,
    note: typeof draft.note === 'string' ? draft.note : undefined,
    occurredAtText: typeof draft.occurredAtText === 'string' ? draft.occurredAtText : undefined,
    imageUri: typeof draft.imageUri === 'string' ? draft.imageUri : undefined,
    location: normalizeTogetherWalkedLocation(draft.location),
    journeyId: typeof draft.journeyId === 'string' ? draft.journeyId : undefined,
    manualPlace: typeof draft.manualPlace === 'string' ? draft.manualPlace : undefined,
    manualLatitude: typeof draft.manualLatitude === 'string' ? draft.manualLatitude : undefined,
    manualLongitude: typeof draft.manualLongitude === 'string' ? draft.manualLongitude : undefined,
  };
}

function formatPlaceLabel(place?: Location.LocationGeocodedAddress) {
  if (!place) return undefined;
  const city = place.city ?? place.subregion ?? place.region;
  if (city && place.district && place.district !== city) return `${city} · ${place.district}`;
  return place.name ?? place.district ?? city ?? place.region ?? undefined;
}

async function getCurrentLocationWithTimeout() {
  return Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<Location.LocationObject>((_, reject) => {
      setTimeout(() => reject(new Error('location-timeout')), LOCATION_TIMEOUT_MS);
    }),
  ]);
}

async function resolveCurrentLocation(): Promise<TogetherWalkedLocation> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('location-denied');
  if (!await Location.hasServicesEnabledAsync()) throw new Error('location-services-disabled');

  let location: Location.LocationObject | null = null;
  try {
    location = await getCurrentLocationWithTimeout();
  } catch {
    location = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60 * 1000, requiredAccuracy: 3000 });
  }
  if (!location) throw new Error('location-unavailable');

  const { latitude, longitude, accuracy } = location.coords;
  if (!isUsableTogetherWalkedCoordinate(latitude, longitude)) throw new Error('location-unavailable');
  let label: string | undefined;
  try {
    const places = await Location.reverseGeocodeAsync({ latitude, longitude });
    label = formatPlaceLabel(places[0]);
  } catch {
    label = undefined;
  }
  return { latitude, longitude, accuracy: typeof accuracy === 'number' ? accuracy : undefined, label };
}

function journeyColor(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0;
  return JOURNEY_COLORS[Math.abs(hash) % JOURNEY_COLORS.length];
}

function mapRegionForPoints(points: Array<{ latitude: number; longitude: number }>) {
  if (!points.length) return undefined;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  return {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: (minLongitude + maxLongitude) / 2,
    latitudeDelta: Math.max((maxLatitude - minLatitude) * 1.45, 0.06),
    longitudeDelta: Math.max((maxLongitude - minLongitude) * 1.45, 0.06),
  };
}

export function TogetherWalkedScreen({ onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<TogetherWalkedEntry[]>([]);
  const [journeys, setJourneys] = useState<TogetherWalkedJourney[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<ViewMode>('journeys');
  const [lastListMode, setLastListMode] = useState<Exclude<ViewMode, 'map'>>('journeys');
  const [selectedJourneyId, setSelectedJourneyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());

  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [occurredAtText, setOccurredAtText] = useState(() => formatDateTimeInput(Date.now()));
  const [draftImageUri, setDraftImageUri] = useState<string | undefined>();
  const [draftLocation, setDraftLocation] = useState<TogetherWalkedLocation | undefined>();
  const [draftJourneyId, setDraftJourneyId] = useState<string | undefined>();
  const [manualPlace, setManualPlace] = useState('');
  const [manualLatitude, setManualLatitude] = useState('');
  const [manualLongitude, setManualLongitude] = useState('');
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const [journeyEditorVisible, setJourneyEditorVisible] = useState(false);
  const [editingJourneyId, setEditingJourneyId] = useState<string | null>(null);
  const [journeyEditorTitle, setJourneyEditorTitle] = useState('');
  const [journeyEditorDescription, setJourneyEditorDescription] = useState('');
  const [journeyEditorTarget, setJourneyEditorTarget] = useState<JourneyPickerTarget | null>(null);
  const [journeySaving, setJourneySaving] = useState(false);
  const [journeyPickerTarget, setJourneyPickerTarget] = useState<JourneyPickerTarget | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [batchJourneyId, setBatchJourneyId] = useState<string | null>(null);
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(() => new Set());
  const [memoryStates, setMemoryStates] = useState<Record<string, EntryMemoryState>>({});
  const [memorySavingIds, setMemorySavingIds] = useState<Set<string>>(() => new Set());
  const [listReadError, setListReadError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const memorySavingRef = useRef(new Set<string>());
  const memoryReadVersions = useRef(new Map<string, number>());
  const listReadVersion = useRef(0);
  const draftRestoreVersion = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const canShowResult = (dataEpoch: number | null) =>
    mountedRef.current && canCommitBackupRestoreDataEpoch(dataEpoch);

  const readEntryMemory = async (id: string) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null || !mountedRef.current) return;
    const version = (memoryReadVersions.current.get(id) ?? 0) + 1;
    memoryReadVersions.current.set(id, version);
    setMemoryStates(current => ({ ...current, [id]: {
      ...current[id], status: 'checking', memoryIds: current[id]?.memoryIds ?? [],
    } }));
    try {
      const link = await loadTogetherWalkedEntryMemoryLink(id);
      if (!canShowResult(dataEpoch) || memoryReadVersions.current.get(id) !== version) return;
      setMemoryStates(current => ({ ...current, [id]: {
        status: link.status, memoryIds: link.memoryIds, memoryId: link.memory?.id,
      } }));
    } catch (error) {
      if (!canShowResult(dataEpoch) || memoryReadVersions.current.get(id) !== version) return;
      setMemoryStates(current => ({ ...current, [id]: {
        ...current[id], status: 'read_failed', memoryIds: current[id]?.memoryIds ?? [],
        notice: `关联无法核对：${error instanceof Error ? error.message : String(error)}`,
      } }));
    }
  };

  const showMemoryResult = (result: TogetherWalkedMemorySaveResult) => {
    const id = result.entry.id;
    listReadVersion.current += 1;
    memoryReadVersions.current.set(id, (memoryReadVersions.current.get(id) ?? 0) + 1);
    setMemoryStates(current => ({ ...current, [id]: {
      status: result.status === 'saved' ? 'linked' : 'link_pending',
      memoryIds: [result.memory.id], memoryId: result.memory.id, committedMemoryId: result.memory.id,
    } }));
  };

  const refresh = async (dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (dataEpoch === null) return null;
    const version = ++listReadVersion.current;
    try {
      const loadedData = await runBackupRestoreDataEpochCommit(dataEpoch, () => loadTogetherWalkedDataStrict());
      if (!loadedData.committed || !canShowResult(dataEpoch) || listReadVersion.current !== version) return null;
      const data = loadedData.value;
      setEntries(data.entries);
      setJourneys(data.journeys);
      setListReadError(null);
      setLoaded(true);
      return data;
    } catch (error) {
      if (canShowResult(dataEpoch) && listReadVersion.current === version)
        setListReadError(`列表无法读取：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (expandedId && !memorySavingRef.current.has(expandedId)) void readEntryMemory(expandedId);
  }, [expandedId, entries]);

  useEffect(() => {
    let active = true;
    const restoreDraft = async () => {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      const version = draftRestoreVersion.current;
      const restored = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        try {
          const raw = await AsyncStorage.getItem(TOGETHER_WALKED_DRAFT_STORAGE_KEY);
          return raw ? normalizeDraft(JSON.parse(raw)) : null;
        } catch {
          await AsyncStorage.removeItem(TOGETHER_WALKED_DRAFT_STORAGE_KEY).catch(() => undefined);
          return null;
        }
      });
      if (!restored.committed || !canCommitBackupRestoreDataEpoch(dataEpoch) || !active
        || draftRestoreVersion.current !== version) return;
      const parsed = restored.value;
      if (parsed) {
        setTitle(parsed.title ?? '');
        setNote(parsed.note ?? '');
        setOccurredAtText(parsed.occurredAtText ?? formatDateTimeInput(Date.now()));
        setDraftImageUri(parsed.imageUri);
        setDraftLocation(parsed.location);
        setDraftJourneyId(parsed.journeyId);
        setManualPlace(parsed.manualPlace ?? parsed.location?.label ?? '');
        setManualLatitude(parsed.manualLatitude ?? (typeof parsed.location?.latitude === 'number' ? parsed.location.latitude.toFixed(5) : ''));
        setManualLongitude(parsed.manualLongitude ?? (typeof parsed.location?.longitude === 'number' ? parsed.location.longitude.toFixed(5) : ''));
      }
      setDraftLoaded(true);
    };
    void restoreDraft();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (loaded && draftJourneyId && !journeys.some((journey) => journey.id === draftJourneyId)) {
      setDraftJourneyId(undefined);
    }
  }, [draftJourneyId, journeys, loaded]);

  useEffect(() => {
    if (!draftLoaded || !loaded || saving) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const hasDraftContent =
      !!title.trim() ||
      !!note.trim() ||
      !!draftImageUri ||
      !!draftLocation ||
      !!manualPlace.trim() ||
      !!manualLatitude.trim() ||
      !!manualLongitude.trim();
    const draft: TogetherWalkedDraft = {
      title,
      note,
      occurredAtText,
      imageUri: draftImageUri,
      location: draftLocation,
      journeyId: draftJourneyId,
      manualPlace,
      manualLatitude,
      manualLongitude,
    };
    const timer = setTimeout(() => {
      void runBackupRestoreDataEpochCommit(dataEpoch, () => (
        hasDraftContent
          ? AsyncStorage.setItem(TOGETHER_WALKED_DRAFT_STORAGE_KEY, JSON.stringify(draft))
          : AsyncStorage.removeItem(TOGETHER_WALKED_DRAFT_STORAGE_KEY)
      )).catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [draftJourneyId, draftLoaded, draftImageUri, draftLocation, loaded, manualLatitude, manualLongitude, manualPlace, note, occurredAtText, saving, title]);

  const journeySummaries = useMemo(
    () => buildTogetherWalkedJourneySummaries(journeys, entries),
    [entries, journeys],
  );
  const journeyById = useMemo(() => new Map(journeys.map((journey) => [journey.id, journey])), [journeys]);
  const summaryByJourneyId = useMemo(
    () => new Map(journeySummaries.map((summary) => [summary.journey.id, summary])),
    [journeySummaries],
  );
  const selectedJourney = selectedJourneyId ? summaryByJourneyId.get(selectedJourneyId) : undefined;
  const unassignedEntries = useMemo(() => entries.filter((entry) => !entry.journeyId), [entries]);
  const coordinateEntries = useMemo(() => entries.filter((entry) => hasCoordinate(entry.location)), [entries]);
  const latestPlace = entries.find((entry) => entry.location?.label || hasCoordinate(entry.location))?.location;
  const latestEntry = entries[0];
  const draftJourney = draftJourneyId ? journeyById.get(draftJourneyId) : undefined;
  const batchJourney = batchJourneyId ? journeyById.get(batchJourneyId) : undefined;
  const pickerEntry = journeyPickerTarget?.kind === 'entry'
    ? entries.find((entry) => entry.id === journeyPickerTarget.entryId)
    : undefined;
  const pickerSelectedJourneyId = journeyPickerTarget?.kind === 'draft' ? draftJourneyId : pickerEntry?.journeyId;
  const hasUnsavedDraft =
    !!title.trim() ||
    !!note.trim() ||
    !!draftImageUri ||
    !!draftLocation ||
    !!manualPlace.trim() ||
    !!manualLatitude.trim() ||
    !!manualLongitude.trim();
  const overviewRegion = mapRegionForPoints(
    coordinateEntries.map((entry) => ({ latitude: entry.location!.latitude!, longitude: entry.location!.longitude! })),
  );

  const showListMode = (nextMode: Exclude<ViewMode, 'map'>) => {
    setLastListMode(nextMode);
    setMode(nextMode);
  };

  const pickImage = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!permission.granted) {
      Alert.alert('需要相册权限', '需要相册权限才能添加一起走过的照片。');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.9 });
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!result.canceled && result.assets[0]?.uri) {
      const previousImageUri = draftImageUri;
      try {
        const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          const persistentUri = await copyDraftImageToAppStorage(result.assets[0].uri);
          await deleteDraftImage(previousImageUri);
          return persistentUri;
        });
        if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        setDraftImageUri(committed.value);
      } catch {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        setDraftImageUri(result.assets[0].uri);
        Alert.alert('照片已先放进草稿', '这张照片暂时没能复制进本地目录，正式保存时会再试一次。');
      }
    }
  };

  const removeDraftImage = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const imageUri = draftImageUri;
    const removed = await runBackupRestoreDataEpochCommit(dataEpoch, () => deleteDraftImage(imageUri));
    if (!removed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    setDraftImageUri(undefined);
  };

  const useCurrentLocation = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setLocating(true);
    try {
      const nextLocation = await resolveCurrentLocation();
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setDraftLocation(nextLocation);
      setManualPlace(nextLocation.label ?? '');
      setManualLatitude(nextLocation.latitude?.toFixed(5) ?? '');
      setManualLongitude(nextLocation.longitude?.toFixed(5) ?? '');
      setLocationNotice(null);
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const reason = error instanceof Error ? error.message : '';
      const message = reason === 'location-denied'
        ? '没有定位权限，也可以先保存文字和照片。'
        : reason === 'location-services-disabled'
          ? '系统定位服务好像关着，可以打开定位，或者先用补录地点。'
          : '这次没有拿到当前位置，可以先保存文字和照片，或者用补录地点。';
      setLocationNotice(message);
    } finally {
      setLocating(false);
    }
  };

  const useManualLocation = () => {
    const label = manualPlace.trim();
    const latitude = Number(manualLatitude.trim());
    const longitude = Number(manualLongitude.trim());
    const hasManualCoordinate = isUsableTogetherWalkedCoordinate(latitude, longitude);
    if (!label && !hasManualCoordinate) {
      Alert.alert('还没有补录地点', '可以只写地点名，比如“惠州市 · 惠阳区”；如果知道坐标，也可以一起填。');
      return;
    }
    setDraftLocation({
      label: label || undefined,
      latitude: hasManualCoordinate ? latitude : undefined,
      longitude: hasManualCoordinate ? longitude : undefined,
    });
    setLocationNotice(null);
  };

  const geocodeManualPlace = async () => {
    const label = manualPlace.trim();
    if (!label || geocoding) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setGeocoding(true);
    try {
      const results = await Location.geocodeAsync(label);
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const first = results[0];
      if (!first) {
        setDraftLocation({ label });
        Alert.alert('先保存地点名', '没有查到坐标，但地点名已经可以补录进这条记录。');
        return;
      }
      setDraftLocation({ label, latitude: first.latitude, longitude: first.longitude });
      setManualLatitude(first.latitude.toFixed(5));
      setManualLongitude(first.longitude.toFixed(5));
      setLocationNotice(null);
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setDraftLocation({ label });
      Alert.alert('先保存地点名', '这次没有查到坐标，但地点名已经可以补录进这条记录。');
    } finally {
      setGeocoding(false);
    }
  };

  const saveEntry = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || savingRef.current) return;
    const occurredAt = parseDateTimeInput(occurredAtText);
    if (!occurredAt) {
      Alert.alert('时间格式不对', '请按 2026-06-28 16:56 这样的格式填写补录时间。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await createTogetherWalkedEntry({
        title: trimmedTitle,
        note,
        imageUri: draftImageUri,
        location: draftLocation,
        journeyId: draftJourneyId,
        occurredAt,
      }, { dataEpoch });
      if (!canShowResult(dataEpoch)) return;
      listReadVersion.current += 1;
      draftRestoreVersion.current += 1;
      setEntries(current => [result.entry, ...current.filter(entry => entry.id !== result.entry.id)]);
      if (result.memoryResult) showMemoryResult(result.memoryResult);
      setExpandedId(result.entry.id);
      setTitle('');
      setNote('');
      setOccurredAtText(formatDateTimeInput(Date.now()));
      setDraftImageUri(undefined);
      setDraftLocation(undefined);
      setDraftJourneyId(result.entry.journeyId);
      setManualPlace('');
      setManualLatitude('');
      setManualLongitude('');
      setLocationNotice(null);
      setDraftLoaded(true);
      showListMode('entries');
      const messages = [
        result.imageSaveFailed ? '照片没有复制成功，这条已按文字和地点保存。' : '',
        result.memoryResult?.status === 'link_pending'
          ? `正式记忆已保存，条目关联待补接。卡号：${result.memoryResult.memory.id}`
          : result.memorySyncFailed ? '出行条目已保存，普通记忆尚未确认保存。请展开该条核对后补存。' : '',
        result.entrySaveWarning ? '出行条目已保存，旅程或同步后续步骤未完成。' : '',
      ].filter(Boolean);
      try {
        await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          await AsyncStorage.removeItem(TOGETHER_WALKED_DRAFT_STORAGE_KEY);
          await deleteDraftImage(draftImageUri);
        });
      } catch {
        messages.push('出行条目已保存，旧草稿清理未完成。');
      }
      if (!canShowResult(dataEpoch)) return;
      try {
        if (!await refresh(dataEpoch) && canShowResult(dataEpoch)) messages.push('出行条目已保存，列表刷新未完成。');
      }
      catch { messages.push('出行条目已保存，列表刷新未完成。'); }
      if (messages.length && canShowResult(dataEpoch)) Alert.alert('已保存', messages.join('\n'));
    } catch (error) {
      if (canShowResult(dataEpoch)) Alert.alert('保存未完成', error instanceof Error ? error.message : String(error));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const retryEntryMemory = async (id: string) => {
    if (memorySavingRef.current.has(id)) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null || !mountedRef.current) return;
    memorySavingRef.current.add(id);
    memoryReadVersions.current.set(id, (memoryReadVersions.current.get(id) ?? 0) + 1);
    setMemorySavingIds(new Set(memorySavingRef.current));
    try {
      const link = await loadTogetherWalkedEntryMemoryLink(id);
      if (!canShowResult(dataEpoch)) return;
      setMemoryStates(current => ({ ...current, [id]: {
        status: link.status, memoryIds: link.memoryIds, memoryId: link.memory?.id,
      } }));
      if (link.status === 'missing' || link.status === 'archived' || link.status === 'conflict') return;
      const result = await retryTogetherWalkedMemory(id, { dataEpoch });
      if (!canShowResult(dataEpoch)) return;
      showMemoryResult(result);
      setEntries(current => current.map(entry => entry.id === id ? result.entry : entry));
      try {
        if (!await refresh(dataEpoch) && canShowResult(dataEpoch)) setMemoryStates(current => ({ ...current, [id]: {
          ...current[id], notice: '正式记忆已保存，列表刷新未完成。',
        } }));
      }
      catch {
        if (canShowResult(dataEpoch)) setMemoryStates(current => ({ ...current, [id]: {
          ...current[id], notice: '正式记忆已保存，列表刷新未完成。',
        } }));
      }
    } catch (error) {
      if (!canShowResult(dataEpoch)) return;
      const message = `补存未完成：${error instanceof Error ? error.message : String(error)}`;
      try {
        const link = await loadTogetherWalkedEntryMemoryLink(id);
        if (canShowResult(dataEpoch)) setMemoryStates(current => ({ ...current, [id]: {
          status: link.status, memoryIds: link.memoryIds, memoryId: link.memory?.id, notice: message,
        } }));
      } catch {
        if (canShowResult(dataEpoch)) setMemoryStates(current => ({ ...current, [id]: {
          ...current[id], status: 'read_failed', memoryIds: current[id]?.memoryIds ?? [], notice: message,
        } }));
      }
    } finally {
      memorySavingRef.current.delete(id);
      if (mountedRef.current) setMemorySavingIds(new Set(memorySavingRef.current));
    }
  };

  const confirmDeleteEntry = (entry: TogetherWalkedEntry) => {
    Alert.alert('删除这段一起走过？', '会删除这条旅行记录和它保存的本地照片，不会删除已经同步进普通记忆的内容。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          const dataEpoch = captureBackupRestoreDataEpoch();
          if (dataEpoch === null) return;
          void deleteTogetherWalkedEntry(entry.id, { dataEpoch }).then(async () => {
            const refreshed = await refresh(dataEpoch);
            if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
            if (expandedId === entry.id) setExpandedId(null);
          }).catch(() => undefined);
        },
      },
    ]);
  };

  const markImageBroken = (id: string) => {
    setBrokenImages((current) => new Set([...current, id]));
  };

  const openJourneyEditor = (journey?: TogetherWalkedJourney, target: JourneyPickerTarget | null = null) => {
    setEditingJourneyId(journey?.id ?? null);
    setJourneyEditorTitle(journey?.title ?? '');
    setJourneyEditorDescription(journey?.description ?? '');
    setJourneyEditorTarget(target);
    setJourneyEditorVisible(true);
  };

  const closeJourneyEditor = () => {
    if (journeySaving) return;
    setJourneyEditorVisible(false);
    setEditingJourneyId(null);
    setJourneyEditorTarget(null);
  };

  const applyJourneySelection = async (
    target: JourneyPickerTarget,
    journeyId?: string,
    dataEpoch = captureBackupRestoreDataEpoch(),
  ) => {
    if (dataEpoch === null) return false;
    if (target.kind === 'draft') {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      setDraftJourneyId(journeyId);
      setJourneyPickerTarget(null);
      return true;
    }
    setAssigning(true);
    try {
      await assignTogetherWalkedEntries([target.entryId], journeyId, { dataEpoch });
      const refreshed = await refresh(dataEpoch);
      if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      setJourneyPickerTarget(null);
      return true;
    } finally {
      setAssigning(false);
    }
  };

  const saveJourney = async () => {
    const journeyTitle = journeyEditorTitle.trim();
    if (!journeyTitle || journeySaving) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setJourneySaving(true);
    try {
      if (editingJourneyId) {
        await updateTogetherWalkedJourney(editingJourneyId, {
          title: journeyTitle,
          description: journeyEditorDescription,
        }, { dataEpoch });
        const refreshed = await refresh(dataEpoch);
        if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      } else {
        const created = await createTogetherWalkedJourney({
          title: journeyTitle,
          description: journeyEditorDescription,
        }, { dataEpoch });
        if (journeyEditorTarget?.kind === 'entry') {
          const applied = await applyJourneySelection(journeyEditorTarget, created.id, dataEpoch);
          if (!applied || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        } else {
          const refreshed = await refresh(dataEpoch);
          if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
          if (journeyEditorTarget) {
            const applied = await applyJourneySelection(journeyEditorTarget, created.id, dataEpoch);
            if (!applied || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
          }
        }
      }
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setJourneyEditorVisible(false);
      setEditingJourneyId(null);
      setJourneyEditorTarget(null);
    } finally {
      setJourneySaving(false);
    }
  };

  const beginNewJourneyFromPicker = () => {
    const target = journeyPickerTarget;
    setJourneyPickerTarget(null);
    openJourneyEditor(undefined, target);
  };

  const confirmDeleteJourney = (summary: TogetherWalkedJourneySummary) => {
    const remove = async (deleteEntries: boolean) => {
      const dataEpoch = captureBackupRestoreDataEpoch();
      if (dataEpoch === null) return;
      await deleteTogetherWalkedJourney(summary.journey.id, deleteEntries, { dataEpoch });
      const refreshed = await refresh(dataEpoch);
      if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setSelectedJourneyId(null);
      setExpandedId(null);
    };
    Alert.alert(
      `删除“${summary.journey.title}”？`,
      `这段旅程里有 ${summary.entries.length} 条脚印。已经同步进普通记忆的摘要都会保留。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '只删旅程', onPress: () => void remove(false) },
        { text: '连脚印一起删', style: 'destructive', onPress: () => void remove(true) },
      ],
    );
  };

  const continueJourney = (journeyId: string) => {
    setDraftJourneyId(journeyId);
    setSelectedJourneyId(null);
    showListMode('entries');
  };

  const openBatchPicker = (journeyId: string) => {
    if (!unassignedEntries.length) {
      Alert.alert('没有待整理的脚印', '现在没有未归入旅程的脚印。单条记录仍可以在详情里更改旅程。');
      return;
    }
    setBatchJourneyId(journeyId);
    setBatchSelectedIds(new Set());
  };

  const toggleBatchEntry = (entryId: string) => {
    setBatchSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const confirmBatchAssign = async () => {
    if (!batchJourneyId || !batchSelectedIds.size || assigning) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const journeyId = batchJourneyId;
    const entryIds = [...batchSelectedIds];
    setAssigning(true);
    try {
      await assignTogetherWalkedEntries(entryIds, journeyId, { dataEpoch });
      const refreshed = await refresh(dataEpoch);
      if (!refreshed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      setBatchJourneyId(null);
      setBatchSelectedIds(new Set());
    } finally {
      setAssigning(false);
    }
  };

  const renderEntryImage = (entry: TogetherWalkedEntry, size: 'card' | 'detail') => {
    if (!entry.imageUri || brokenImages.has(entry.id)) {
      return (
        <View style={[styles.imagePlaceholder, size === 'detail' && styles.detailImage]}>
          <Text style={styles.imagePlaceholderText}>{entry.imageUri ? '照片暂时不见了' : '没有照片'}</Text>
        </View>
      );
    }
    return (
      <Pressable onPress={() => setPreviewUri(entry.imageUri ?? null)}>
        <Image
          onError={() => markImageBroken(entry.id)}
          source={{ uri: entry.imageUri }}
          style={size === 'detail' ? styles.detailImage : styles.cardImage}
        />
      </Pressable>
    );
  };

  const renderEntryCard = (entry: TogetherWalkedEntry, compact = false) => {
    const expanded = expandedId === entry.id;
    const journey = entry.journeyId ? journeyById.get(entry.journeyId) : undefined;
    const memoryState = memoryStates[entry.id];
    const memoryBusy = memorySavingIds.has(entry.id);
    const memoryBlocked = !memoryState || ['checking', 'read_failed', 'missing', 'archived', 'conflict'].includes(memoryState.status);
    const memoryLinked = memoryState?.status === 'linked' && !!memoryState.memoryId && entry.memoryId === memoryState.memoryId;
    const memoryStatusText = !memoryState || memoryState.status === 'checking' ? '正在核对普通记忆关联。'
      : memoryState.status === 'read_failed' ? '普通记忆关联无法核对，已停止补存。'
        : memoryState.status === 'missing' ? '已知原记忆不存在，已停止补存。'
          : memoryState.status === 'archived' ? '原记忆已归档，已停止补存。'
            : memoryState.status === 'conflict' ? '记忆关联存在冲突，已停止补存。'
              : memoryState.status === 'unlinked' ? '尚未找到普通记忆，可以补存。'
                : memoryLinked ? '已关联普通记忆。' : '正式记忆已保存，条目关联待补接。';
    return (
      <Pressable
        key={entry.id}
        onPress={() => setExpandedId(expanded ? null : entry.id)}
        style={[styles.memoryCard, compact && styles.timelineCard]}
      >
        <View style={styles.cardTop}>
          {renderEntryImage(entry, 'card')}
          <View style={styles.cardCopy}>
            <Text numberOfLines={2} style={styles.cardTitle}>{entry.title}</Text>
            <Text style={styles.cardMeta}>{formatFullDate(entry.createdAt)}</Text>
            <Text numberOfLines={1} style={styles.cardPlace}>
              {entry.location?.label ?? (hasCoordinate(entry.location) ? '已记录坐标' : '未记录地点')}
            </Text>
            {journey ? <Text numberOfLines={1} style={styles.entryJourneyChip}>{journey.title}</Text> : null}
          </View>
          <Pressable
            accessibilityLabel={`删除${entry.title}`}
            onPress={(event) => {
              event.stopPropagation();
              confirmDeleteEntry(entry);
            }}
            style={styles.deleteButton}
          >
            <Text style={styles.deleteText}>删</Text>
          </Pressable>
        </View>
        {expanded ? (
          <View style={styles.expanded}>
            {entry.note ? <Text style={styles.noteText}>{entry.note}</Text> : <Text style={styles.mutedText}>这段路还没有写下详细回忆。</Text>}
            {renderEntryImage(entry, 'detail')}
            {entry.location ? (
              <View style={styles.locationPanel}>
                <Text style={styles.locationTitle}>{entry.location.label ?? '记录的地点'}</Text>
                <Text style={styles.locationText}>
                  {hasCoordinate(entry.location) ? `${entry.location.latitude!.toFixed(5)}, ${entry.location.longitude!.toFixed(5)}` : '只有地点名，没有坐标'}
                </Text>
                {hasCoordinate(entry.location) ? (
                  <MapView
                    style={styles.compactMap}
                    initialRegion={{
                      latitude: entry.location.latitude!,
                      longitude: entry.location.longitude!,
                      latitudeDelta: 0.01,
                      longitudeDelta: 0.01,
                    }}
                  >
                    <Marker coordinate={{ latitude: entry.location.latitude!, longitude: entry.location.longitude! }} title={entry.title} />
                  </MapView>
                ) : null}
              </View>
            ) : (
              <Text style={styles.mutedText}>这条没有记录地点，地图里会先安静地略过它。</Text>
            )}
            <View style={styles.entryDetailActions}>
              <Pressable
                disabled={memoryBusy || memoryBlocked || memoryLinked}
                onPress={(event) => { event.stopPropagation(); void retryEntryMemory(entry.id); }}
                style={[styles.smallAction, (memoryBusy || memoryBlocked || memoryLinked) && styles.disabledAction]}
              >
                <Text style={styles.smallActionText}>{memoryBusy ? '补存中' : memoryLinked ? '已关联记忆'
                  : memoryState?.status === 'linked' || memoryState?.status === 'link_pending' ? '补接关联' : '补存记忆'}</Text>
              </Pressable>
              <Pressable
                disabled={memoryBusy || memoryState?.status === 'checking'}
                onPress={(event) => { event.stopPropagation(); void readEntryMemory(entry.id); }}
                style={[styles.smallAction, (memoryBusy || memoryState?.status === 'checking') && styles.disabledAction]}
              >
                <Text style={styles.smallActionText}>重新核对</Text>
              </Pressable>
              <Pressable
                onPress={(event) => {
                  event.stopPropagation();
                  setJourneyPickerTarget({ kind: 'entry', entryId: entry.id });
                }}
                style={styles.smallAction}
              >
                <Text style={styles.smallActionText}>{journey ? '更改旅程' : '归入旅程'}</Text>
              </Pressable>
              {journey ? (
                <Pressable
                  onPress={(event) => {
                    event.stopPropagation();
                    void applyJourneySelection({ kind: 'entry', entryId: entry.id }, undefined);
                  }}
                  style={styles.smallAction}
                >
                  <Text style={styles.smallActionText}>移出旅程</Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.memorySyncText}>{memoryStatusText}</Text>
            {memoryState?.memoryIds.length ? <Text style={styles.mutedText}>卡号：{memoryState.memoryIds.join('、')}</Text> : null}
            {memoryState?.status === 'read_failed' && memoryState.committedMemoryId
              ? <Text style={styles.mutedText}>正式记忆已保存，卡号：{memoryState.committedMemoryId}</Text> : null}
            {memoryState?.notice ? <Text style={styles.mutedText}>{memoryState.notice}</Text> : null}
          </View>
        ) : null}
      </Pressable>
    );
  };

  const renderJourneyMap = (summary: TogetherWalkedJourneySummary) => {
    const region = mapRegionForPoints(summary.routePoints);
    if (!region) {
      return (
        <View style={styles.journeyEmptyMap}>
          <Text style={styles.emptyTitle}>这段旅程还没有地图脚印</Text>
          <Text style={styles.emptyText}>只有地点名的记录也会留在下面的时间线里。</Text>
        </View>
      );
    }
    const color = journeyColor(summary.journey.id);
    const coordinates = summary.routePoints.map((point) => ({ latitude: point.latitude, longitude: point.longitude }));
    return (
      <MapView style={styles.journeyMap} initialRegion={region}>
        {coordinates.length > 1 ? <Polyline coordinates={coordinates} strokeColor={color} strokeWidth={4} /> : null}
        {summary.routePoints.map((point, index) => (
          <Marker
            key={point.entryId}
            coordinate={{ latitude: point.latitude, longitude: point.longitude }}
            description={`${index + 1} / ${summary.routePoints.length}`}
            pinColor={color}
            title={point.title}
          />
        ))}
      </MapView>
    );
  };

  const renderJourneyDetail = (summary: TogetherWalkedJourneySummary) => (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 32, 52) }]}
      showsVerticalScrollIndicator={false}
    >
      {summary.coverImageUri && !brokenImages.has(`journey-${summary.journey.id}`) ? (
        <Pressable onPress={() => setPreviewUri(summary.coverImageUri ?? null)}>
          <Image
            onError={() => markImageBroken(`journey-${summary.journey.id}`)}
            source={{ uri: summary.coverImageUri }}
            style={styles.journeyHeroImage}
          />
        </Pressable>
      ) : null}
      <View style={styles.journeyIntroBand}>
        <Text style={styles.journeyRange}>{formatJourneyRange(summary.startAt, summary.endAt)}</Text>
        <Text style={styles.journeyDescription}>
          {summary.journey.description || '这段旅程还没有写简介。'}
        </Text>
        <Text numberOfLines={2} style={styles.journeyPlaceChain}>
          {summary.placeLabels.length ? summary.placeLabels.join(' → ') : '还没有记录地点'}
        </Text>
      </View>

      <View style={styles.journeyActions}>
        <Pressable onPress={() => continueJourney(summary.journey.id)} style={styles.primaryCompactAction}>
          <Text style={styles.primaryCompactActionText}>继续记录</Text>
        </Pressable>
        <Pressable onPress={() => openBatchPicker(summary.journey.id)} style={styles.secondaryAction}>
          <Text style={styles.secondaryActionText}>添加已有脚印</Text>
        </Pressable>
        <Pressable onPress={() => confirmDeleteJourney(summary)} style={styles.dangerOutlineAction}>
          <Text style={styles.dangerOutlineText}>删除旅程</Text>
        </Pressable>
      </View>

      <View style={styles.sectionHeadingRow}>
        <View>
          <Text style={styles.sectionTitle}>旅程地图</Text>
          <Text style={styles.sectionMeta}>{summary.routePoints.length} 个地图地点</Text>
        </View>
      </View>
      {renderJourneyMap(summary)}

      <View style={styles.sectionHeadingRow}>
        <View>
          <Text style={styles.sectionTitle}>一路走来</Text>
          <Text style={styles.sectionMeta}>{summary.entries.length} 段脚印，按时间从早到晚</Text>
        </View>
      </View>
      {summary.entries.length ? summary.entries.map((entry, index) => (
        <View key={entry.id} style={styles.timelineRow}>
          <View style={styles.timelineRail}>
            <View style={[styles.timelineDot, { backgroundColor: journeyColor(summary.journey.id) }]} />
            {index < summary.entries.length - 1 ? <View style={styles.timelineLine} /> : null}
          </View>
          <View style={styles.timelineContent}>{renderEntryCard(entry, true)}</View>
        </View>
      )) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>旅程已经建好</Text>
          <Text style={styles.emptyText}>下一段脚印可以直接继续记进这里。</Text>
        </View>
      )}
    </ScrollView>
  );

  const renderOverviewMap = () => {
    if (!overviewRegion || !coordinateEntries.length) {
      return (
        <View style={styles.mapPage}>
          <View style={styles.emptyMap}>
            <Text style={styles.emptyTitle}>还没有带地点的记录</Text>
            <Text style={styles.emptyText}>现场可以点“当前位置”，补录时也可以写地点名再查坐标。</Text>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.mapPage}>
        <MapView style={styles.overviewMap} initialRegion={overviewRegion}>
          {journeySummaries.map((summary) => {
            const coordinates = summary.routePoints.map((point) => ({ latitude: point.latitude, longitude: point.longitude }));
            return coordinates.length > 1 ? (
              <Polyline
                key={`line-${summary.journey.id}`}
                coordinates={coordinates}
                strokeColor={journeyColor(summary.journey.id)}
                strokeWidth={4}
              />
            ) : null;
          })}
          {coordinateEntries.map((entry) => {
            const journey = entry.journeyId ? journeyById.get(entry.journeyId) : undefined;
            return (
              <Marker
                key={entry.id}
                coordinate={{ latitude: entry.location!.latitude!, longitude: entry.location!.longitude! }}
                description={entry.location?.label ?? formatDate(entry.createdAt)}
                onPress={() => {
                  if (journey) {
                    setSelectedJourneyId(journey.id);
                    setExpandedId(entry.id);
                  } else {
                    setExpandedId(entry.id);
                    showListMode('entries');
                  }
                }}
                pinColor={journey ? journeyColor(journey.id) : '#A8948C'}
                title={entry.title}
              />
            );
          })}
        </MapView>
      </View>
    );
  };

  const renderJourneyList = () => (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 32, 52) }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.sectionHeadingRow}>
        <View>
          <Text style={styles.sectionTitle}>我的旅程</Text>
          <Text style={styles.sectionMeta}>把同一次远行收进一条路里</Text>
        </View>
        <Pressable onPress={() => openJourneyEditor()} style={styles.addJourneyButton}>
          <Text style={styles.addJourneyText}>新建旅程</Text>
        </Pressable>
      </View>
      {!loaded ? (
        <ActivityIndicator color="#D87767" style={styles.loader} />
      ) : journeySummaries.length ? journeySummaries.map((summary) => {
        const coverKey = `journey-${summary.journey.id}`;
        return (
          <Pressable
            key={summary.journey.id}
            onPress={() => setSelectedJourneyId(summary.journey.id)}
            style={styles.journeyCard}
          >
            {summary.coverImageUri && !brokenImages.has(coverKey) ? (
              <Image
                onError={() => markImageBroken(coverKey)}
                source={{ uri: summary.coverImageUri }}
                style={styles.journeyCover}
              />
            ) : (
              <View style={[styles.journeyCover, styles.journeyCoverPlaceholder]}>
                <Text style={styles.journeyCoverCount}>{summary.entries.length}</Text>
                <Text style={styles.journeyCoverLabel}>段脚印</Text>
              </View>
            )}
            <View style={styles.journeyCardCopy}>
              <View style={styles.journeyCardTitleRow}>
                <View style={[styles.journeyColorMark, { backgroundColor: journeyColor(summary.journey.id) }]} />
                <Text numberOfLines={1} style={styles.journeyCardTitle}>{summary.journey.title}</Text>
              </View>
              <Text style={styles.journeyCardDate}>{formatJourneyRange(summary.startAt, summary.endAt)}</Text>
              {summary.journey.description ? (
                <Text numberOfLines={2} style={styles.journeyCardDescription}>{summary.journey.description}</Text>
              ) : null}
              <Text numberOfLines={2} style={styles.journeyCardPlaces}>
                {summary.placeLabels.length ? summary.placeLabels.join(' → ') : '还没有记录地点'}
              </Text>
            </View>
          </Pressable>
        );
      }) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>还没有建立旅程</Text>
          <Text style={styles.emptyText}>可以从“美国之行”开始，把纽约、华盛顿和后面的路串在一起。</Text>
        </View>
      )}
    </ScrollView>
  );

  const renderEntryList = () => (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 32, 52) }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.composer}>
        <Text style={styles.composerTitle}>新的一段路</Text>
        {draftLoaded ? (
          <Text style={styles.draftHint}>{hasUnsavedDraft ? '草稿会自动保存，退出后还能继续编辑。' : '没写完也没关系，这里会自动留草稿。'}</Text>
        ) : null}
        <Pressable onPress={() => setJourneyPickerTarget({ kind: 'draft' })} style={styles.journeySelector}>
          <View style={styles.journeySelectorCopy}>
            <Text style={styles.journeySelectorLabel}>所属旅程</Text>
            <Text numberOfLines={1} style={styles.journeySelectorValue}>{draftJourney?.title ?? '不归入旅程'}</Text>
          </View>
          <Text style={styles.journeySelectorAction}>选择</Text>
        </Pressable>
        <TextInput
          onChangeText={setTitle}
          placeholder="给这段脚印起个名字"
          placeholderTextColor="#B99183"
          style={styles.input}
          value={title}
        />
        <View style={styles.backfillPanel}>
          <View style={styles.backfillHeader}>
            <Text style={styles.backfillTitle}>补录时间</Text>
            <View style={styles.quickDateRow}>
              <Pressable onPress={() => setOccurredAtText(formatDateTimeInput(Date.now()))} style={styles.quickDateButton}>
                <Text style={styles.quickDateText}>现在</Text>
              </Pressable>
              <Pressable onPress={() => setOccurredAtText(formatDateTimeInput(Date.now() - DAY_MS))} style={styles.quickDateButton}>
                <Text style={styles.quickDateText}>昨天</Text>
              </Pressable>
            </View>
          </View>
          <TextInput
            onChangeText={setOccurredAtText}
            placeholder="2026-06-28 16:56"
            placeholderTextColor="#B99183"
            style={[styles.input, styles.compactInput]}
            value={occurredAtText}
          />
        </View>
        <TextInput
          multiline
          onChangeText={setNote}
          placeholder="写一点当时的风、路、心情"
          placeholderTextColor="#B99183"
          style={[styles.input, styles.noteInput]}
          value={note}
        />
        {draftImageUri ? (
          <View style={styles.draftPreviewRow}>
            <Image source={{ uri: draftImageUri }} style={styles.draftImage} />
            <Pressable onPress={removeDraftImage} style={styles.smallAction}>
              <Text style={styles.smallActionText}>移除照片</Text>
            </Pressable>
          </View>
        ) : null}
        {draftLocation ? (
          <View style={styles.locationChip}>
            <Text style={styles.locationChipTitle}>{draftLocation.label ?? '已记录地点'}</Text>
            <Text style={styles.locationChipText}>
              {hasCoordinate(draftLocation) ? `${draftLocation.latitude!.toFixed(5)}, ${draftLocation.longitude!.toFixed(5)}` : '只有地点名，地图里不会显示标记'}
            </Text>
          </View>
        ) : null}
        {locationNotice ? (
          <View style={styles.locationNotice}>
            <Text style={styles.locationNoticeText}>{locationNotice}</Text>
          </View>
        ) : null}
        <View style={styles.manualLocationPanel}>
          <Text style={styles.backfillTitle}>事后补录地点</Text>
          <TextInput
            onChangeText={setManualPlace}
            placeholder="比如：惠州市 · 惠阳区"
            placeholderTextColor="#7E9BB4"
            style={[styles.input, styles.locationInput]}
            value={manualPlace}
          />
          <View style={styles.coordinateRow}>
            <TextInput
              keyboardType="decimal-pad"
              onChangeText={setManualLatitude}
              placeholder="纬度，可不填"
              placeholderTextColor="#7E9BB4"
              style={[styles.input, styles.coordinateInput]}
              value={manualLatitude}
            />
            <TextInput
              keyboardType="decimal-pad"
              onChangeText={setManualLongitude}
              placeholder="经度，可不填"
              placeholderTextColor="#7E9BB4"
              style={[styles.input, styles.coordinateInput]}
              value={manualLongitude}
            />
          </View>
          <View style={styles.manualLocationActions}>
            <Pressable disabled={!manualPlace.trim() || geocoding} onPress={geocodeManualPlace} style={[styles.secondaryAction, (!manualPlace.trim() || geocoding) && styles.disabledAction]}>
              <Text style={styles.secondaryActionText}>{geocoding ? '查找中' : '按地点名查坐标'}</Text>
            </Pressable>
            <Pressable onPress={useManualLocation} style={styles.secondaryAction}>
              <Text style={styles.secondaryActionText}>使用补录地点</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.composerActions}>
          <Pressable onPress={pickImage} style={styles.secondaryAction}>
            <Text style={styles.secondaryActionText}>照片</Text>
          </Pressable>
          <Pressable disabled={locating} onPress={useCurrentLocation} style={[styles.secondaryAction, locating && styles.disabledAction]}>
            <Text style={styles.secondaryActionText}>{locating ? '定位中' : '当前位置'}</Text>
          </Pressable>
          <Pressable disabled={!title.trim() || saving} onPress={saveEntry} style={[styles.primaryAction, (!title.trim() || saving) && styles.disabledAction]}>
            {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryActionText}>保存</Text>}
          </Pressable>
        </View>
      </View>

      <View style={styles.sectionHeadingRow}>
        <View>
          <Text style={styles.sectionTitle}>全部脚印</Text>
          <Text style={styles.sectionMeta}>{entries.length} 段同行记忆</Text>
        </View>
      </View>
      {!loaded ? (
        <ActivityIndicator color="#D87767" style={styles.loader} />
      ) : entries.length ? entries.map((entry) => renderEntryCard(entry)) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>还没有留下脚印</Text>
          <Text style={styles.emptyText}>下一次出门时，拍一张照片、写一句话，把这段路留在这里。</Text>
        </View>
      )}
    </ScrollView>
  );

  return (
    <View style={[styles.page, { paddingTop: Math.max(insets.top + 4, 42), paddingBottom: Math.max(insets.bottom, 8) }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityLabel={selectedJourney ? '返回旅程列表' : '关闭一起走过'}
          onPress={() => selectedJourney ? setSelectedJourneyId(null) : onClose()}
          style={styles.roundButton}
        >
          <Text style={styles.roundButtonText}>‹</Text>
        </Pressable>
        <View style={styles.headerTitleWrap}>
          <Text numberOfLines={1} style={styles.title}>{selectedJourney?.journey.title ?? '一起走过'}</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {selectedJourney ? `${selectedJourney.entries.length} 段脚印串成这次旅程` : '把出门、照片和地点收进同一本相册'}
          </Text>
        </View>
        {selectedJourney ? (
          <Pressable accessibilityLabel="编辑旅程" onPress={() => openJourneyEditor(selectedJourney.journey)} style={styles.roundButton}>
            <Text style={styles.headerActionText}>编</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="切换足迹地图"
            onPress={() => setMode((current) => current === 'map' ? lastListMode : 'map')}
            style={styles.roundButton}
          >
            <Text style={styles.headerActionText}>{mode === 'map' ? '列' : '图'}</Text>
          </Pressable>
        )}
      </View>

      {!selectedJourney ? (
        <View style={styles.statsPanel}>
          <View style={styles.statBlock}>
            <Text style={styles.statsNumber}>{journeys.length}</Text>
            <Text style={styles.statsLabel}>次旅程</Text>
          </View>
          <View style={styles.statsDivider} />
          <View style={styles.statBlock}>
            <Text style={styles.statsNumber}>{entries.length}</Text>
            <Text style={styles.statsLabel}>段脚印</Text>
          </View>
          <View style={styles.statsDivider} />
          <View style={styles.statsCopy}>
            <Text numberOfLines={1} style={styles.statsPlace}>
              {latestPlace?.label ?? (hasCoordinate(latestPlace) ? '已记录坐标' : '还没有地点')}
            </Text>
            <Text numberOfLines={1} style={styles.statsDate}>
              {latestEntry ? `最近 ${formatDate(latestEntry.createdAt)}` : '下一次出门从这里开始'}
            </Text>
          </View>
        </View>
      ) : null}

      {!selectedJourney && mode !== 'map' ? (
        <View style={styles.segmentedControl}>
          <Pressable onPress={() => showListMode('journeys')} style={[styles.segmentButton, mode === 'journeys' && styles.segmentButtonActive]}>
            <Text style={[styles.segmentText, mode === 'journeys' && styles.segmentTextActive]}>旅程</Text>
          </Pressable>
          <Pressable onPress={() => showListMode('entries')} style={[styles.segmentButton, mode === 'entries' && styles.segmentButtonActive]}>
            <Text style={[styles.segmentText, mode === 'entries' && styles.segmentTextActive]}>脚印</Text>
          </Pressable>
        </View>
      ) : null}

      {listReadError ? (
        <View style={styles.locationNotice}>
          <Text style={styles.locationNoticeText}>{listReadError}</Text>
          <Pressable onPress={() => { void refresh().catch(() => undefined); }} style={styles.smallAction}>
            <Text style={styles.smallActionText}>重新读取列表</Text>
          </Pressable>
        </View>
      ) : null}

      {selectedJourney
        ? renderJourneyDetail(selectedJourney)
        : mode === 'map'
          ? renderOverviewMap()
          : mode === 'journeys'
            ? renderJourneyList()
            : renderEntryList()}

      <Modal animationType="fade" transparent visible={!!previewUri} onRequestClose={() => setPreviewUri(null)}>
        <Pressable onPress={() => setPreviewUri(null)} style={styles.previewBackdrop}>
          {previewUri ? <Image resizeMode="contain" source={{ uri: previewUri }} style={styles.previewImage} /> : null}
        </Pressable>
      </Modal>

      <Modal animationType="fade" transparent visible={journeyEditorVisible} onRequestClose={closeJourneyEditor}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          <Pressable onPress={closeJourneyEditor} style={styles.modalBackdropPressable}>
            <Pressable onPress={(event) => event.stopPropagation()} style={styles.modalCard}>
              <Text style={styles.modalTitle}>{editingJourneyId ? '编辑旅程' : '新建旅程'}</Text>
              <TextInput
                autoFocus
                onChangeText={setJourneyEditorTitle}
                placeholder="比如：美国之行"
                placeholderTextColor="#B99183"
                style={styles.input}
                value={journeyEditorTitle}
              />
              <TextInput
                multiline
                onChangeText={setJourneyEditorDescription}
                placeholder="写一句这次旅程的开场"
                placeholderTextColor="#B99183"
                style={[styles.input, styles.journeyDescriptionInput]}
                value={journeyEditorDescription}
              />
              <View style={styles.modalActions}>
                <Pressable disabled={journeySaving} onPress={closeJourneyEditor} style={styles.secondaryAction}>
                  <Text style={styles.secondaryActionText}>取消</Text>
                </Pressable>
                <Pressable disabled={!journeyEditorTitle.trim() || journeySaving} onPress={saveJourney} style={[styles.primaryAction, (!journeyEditorTitle.trim() || journeySaving) && styles.disabledAction]}>
                  {journeySaving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryActionText}>保存旅程</Text>}
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal animationType="fade" transparent visible={!!journeyPickerTarget} onRequestClose={() => !assigning && setJourneyPickerTarget(null)}>
        <View style={styles.modalBackdrop}>
          <Pressable onPress={() => !assigning && setJourneyPickerTarget(null)} style={styles.modalBackdropPressable}>
            <Pressable onPress={(event) => event.stopPropagation()} style={styles.pickerCard}>
              <Text style={styles.modalTitle}>选择所属旅程</Text>
              <ScrollView showsVerticalScrollIndicator={false} style={styles.pickerScroll}>
                <Pressable
                  disabled={assigning || !journeyPickerTarget}
                  onPress={() => journeyPickerTarget && void applyJourneySelection(journeyPickerTarget, undefined)}
                  style={[styles.pickerRow, !pickerSelectedJourneyId && styles.pickerRowActive]}
                >
                  <Text style={styles.pickerRowTitle}>不归入旅程</Text>
                  {!pickerSelectedJourneyId ? <Text style={styles.pickerCheck}>已选</Text> : null}
                </Pressable>
                {journeySummaries.map((summary) => (
                  <Pressable
                    key={summary.journey.id}
                    disabled={assigning || !journeyPickerTarget}
                    onPress={() => journeyPickerTarget && void applyJourneySelection(journeyPickerTarget, summary.journey.id)}
                    style={[styles.pickerRow, pickerSelectedJourneyId === summary.journey.id && styles.pickerRowActive]}
                  >
                    <View style={styles.pickerRowCopy}>
                      <Text numberOfLines={1} style={styles.pickerRowTitle}>{summary.journey.title}</Text>
                      <Text style={styles.pickerRowMeta}>{summary.entries.length} 段脚印</Text>
                    </View>
                    {pickerSelectedJourneyId === summary.journey.id ? <Text style={styles.pickerCheck}>已选</Text> : null}
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable disabled={assigning} onPress={beginNewJourneyFromPicker} style={styles.newJourneyFromPicker}>
                <Text style={styles.newJourneyFromPickerText}>新建旅程</Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </View>
      </Modal>

      <Modal animationType="slide" visible={!!batchJourneyId} onRequestClose={() => !assigning && setBatchJourneyId(null)}>
        <View style={[styles.batchPage, { paddingTop: Math.max(insets.top + 6, 24), paddingBottom: Math.max(insets.bottom + 10, 18) }]}>
          <View style={styles.batchHeader}>
            <Pressable disabled={assigning} onPress={() => setBatchJourneyId(null)} style={styles.roundButton}>
              <Text style={styles.roundButtonText}>‹</Text>
            </Pressable>
            <View style={styles.headerTitleWrap}>
              <Text numberOfLines={1} style={styles.batchTitle}>添加到{batchJourney?.title ?? '旅程'}</Text>
              <Text style={styles.subtitle}>已选择 {batchSelectedIds.size} 段脚印</Text>
            </View>
            <View style={styles.roundButtonSpacer} />
          </View>
          <ScrollView contentContainerStyle={styles.batchContent} showsVerticalScrollIndicator={false}>
            {unassignedEntries.map((entry) => {
              const selected = batchSelectedIds.has(entry.id);
              return (
                <Pressable key={entry.id} onPress={() => toggleBatchEntry(entry.id)} style={[styles.batchEntryRow, selected && styles.batchEntryRowSelected]}>
                  <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
                    {selected ? <Text style={styles.checkboxText}>✓</Text> : null}
                  </View>
                  <View style={styles.batchEntryCopy}>
                    <Text numberOfLines={1} style={styles.batchEntryTitle}>{entry.title}</Text>
                    <Text style={styles.batchEntryMeta}>{formatFullDate(entry.createdAt)} · {entry.location?.label ?? '未记录地点'}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable disabled={!batchSelectedIds.size || assigning} onPress={confirmBatchAssign} style={[styles.batchConfirmButton, (!batchSelectedIds.size || assigning) && styles.disabledAction]}>
            {assigning ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.batchConfirmText}>加入这次旅程</Text>}
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFF9F4', paddingHorizontal: 18 },
  header: { height: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  roundButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE3DB' },
  roundButtonSpacer: { width: 40, height: 40 },
  roundButtonText: { color: '#C96E63', fontSize: 31, lineHeight: 34 },
  headerActionText: { color: '#C96E63', fontSize: 14, fontWeight: '800' },
  headerTitleWrap: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontSize: 25, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.muted, fontSize: 11, textAlign: 'center', marginTop: 2 },
  statsPanel: { minHeight: 86, borderRadius: 20, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 11, marginTop: 13, marginBottom: 11 },
  statBlock: { minWidth: 48, alignItems: 'center' },
  statsNumber: { color: '#C96E63', fontSize: 27, fontWeight: '800', textAlign: 'center' },
  statsLabel: { color: colors.muted, fontSize: 10 },
  statsDivider: { width: 1, alignSelf: 'stretch', backgroundColor: '#FFE3DC' },
  statsCopy: { flex: 1, minWidth: 0, gap: 4 },
  statsPlace: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  statsDate: { color: colors.muted, fontSize: 11 },
  segmentedControl: { height: 42, flexDirection: 'row', backgroundColor: '#F5E8E2', borderRadius: 14, padding: 4, marginBottom: 12 },
  segmentButton: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentButtonActive: { backgroundColor: '#FFFFFF', borderColor: '#F1D9D1', borderWidth: 1 },
  segmentText: { color: '#9B8178', fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: '#C96E63' },
  content: { paddingBottom: 52 },
  sectionHeadingRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 2, marginBottom: 8 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  sectionMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  addJourneyButton: { minHeight: 38, borderRadius: 13, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  addJourneyText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  journeyCard: { minHeight: 134, flexDirection: 'row', backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, borderRadius: 20, overflow: 'hidden', marginBottom: 12 },
  journeyCover: { width: 116, alignSelf: 'stretch', backgroundColor: '#F8ECE7' },
  journeyCoverPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  journeyCoverCount: { color: '#C96E63', fontSize: 28, fontWeight: '800' },
  journeyCoverLabel: { color: '#A78E84', fontSize: 11, marginTop: 2 },
  journeyCardCopy: { flex: 1, minWidth: 0, padding: 13, justifyContent: 'center', gap: 5 },
  journeyCardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  journeyColorMark: { width: 8, height: 8, borderRadius: 4 },
  journeyCardTitle: { flex: 1, color: colors.ink, fontSize: 17, fontWeight: '800' },
  journeyCardDate: { color: '#9A7C72', fontSize: 11, fontWeight: '700' },
  journeyCardDescription: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  journeyCardPlaces: { color: '#5683A9', fontSize: 11, lineHeight: 16, fontWeight: '700' },
  journeyHeroImage: { width: '100%', height: 188, borderRadius: 20, backgroundColor: '#F8ECE7', marginTop: 8, marginBottom: 10 },
  journeyIntroBand: { borderLeftWidth: 3, borderLeftColor: '#EE8D7D', paddingLeft: 13, paddingVertical: 7, marginBottom: 13 },
  journeyRange: { color: '#C96E63', fontSize: 12, fontWeight: '800' },
  journeyDescription: { color: colors.ink, fontSize: 14, lineHeight: 22, marginTop: 5 },
  journeyPlaceChain: { color: '#5683A9', fontSize: 12, lineHeight: 18, fontWeight: '700', marginTop: 5 },
  journeyActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  primaryCompactAction: { minHeight: 40, borderRadius: 13, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 15 },
  primaryCompactActionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  dangerOutlineAction: { minHeight: 40, borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#F1CFC7', borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  dangerOutlineText: { color: '#C96E63', fontSize: 12, fontWeight: '800' },
  journeyMap: { height: 232, borderRadius: 18, marginBottom: 12 },
  journeyEmptyMap: { minHeight: 150, borderRadius: 18, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, alignItems: 'center', justifyContent: 'center', padding: 22, marginBottom: 12 },
  timelineRow: { flexDirection: 'row', alignItems: 'stretch' },
  timelineRail: { width: 24, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 24, zIndex: 1 },
  timelineLine: { width: 2, flex: 1, backgroundColor: '#E5D8D2', marginTop: -1 },
  timelineContent: { flex: 1, minWidth: 0 },
  timelineCard: { marginBottom: 10 },
  composer: { borderRadius: 20, backgroundColor: '#FFF0EA', borderColor: '#FFD8CD', borderWidth: 1, padding: 14, marginBottom: 12 },
  composerTitle: { color: colors.ink, fontSize: 16, fontWeight: '700', marginBottom: 7 },
  draftHint: { color: '#A76F67', fontSize: 11, lineHeight: 16, marginBottom: 9 },
  journeySelector: { minHeight: 52, borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#D8EAF8', borderWidth: 1, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 9 },
  journeySelectorCopy: { flex: 1, minWidth: 0 },
  journeySelectorLabel: { color: '#7E9BB4', fontSize: 10, fontWeight: '700' },
  journeySelectorValue: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: 2 },
  journeySelectorAction: { color: '#5683A9', fontSize: 12, fontWeight: '800' },
  input: { minHeight: 45, borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#FFE0D7', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, color: colors.ink, fontSize: 14, marginBottom: 9 },
  compactInput: { marginBottom: 0 },
  noteInput: { minHeight: 86, lineHeight: 21, textAlignVertical: 'top' },
  backfillPanel: { borderRadius: 16, backgroundColor: '#FFF8F4', borderColor: '#FFE0D7', borderWidth: 1, padding: 10, marginBottom: 9 },
  backfillHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  backfillTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  quickDateRow: { flexDirection: 'row', gap: 6 },
  quickDateButton: { minHeight: 29, borderRadius: 11, backgroundColor: '#FFFFFF', borderColor: '#FFE0D7', borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  quickDateText: { color: '#C96E63', fontSize: 11, fontWeight: '800' },
  draftPreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 9 },
  draftImage: { width: 68, height: 68, borderRadius: 14, backgroundColor: '#F6E4DD' },
  smallAction: { borderRadius: 12, backgroundColor: '#FFFFFF', borderColor: '#FFE0D7', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  smallActionText: { color: '#C96E63', fontSize: 12, fontWeight: '700' },
  locationChip: { borderRadius: 15, backgroundColor: '#EFF8FF', borderColor: '#D3E8F8', borderWidth: 1, padding: 11, marginBottom: 9 },
  locationChipTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  locationChipText: { color: '#5683A9', fontSize: 11, marginTop: 3 },
  locationNotice: { borderRadius: 14, backgroundColor: '#FFF8F4', borderColor: '#FFE0D7', borderWidth: 1, padding: 10, marginBottom: 9 },
  locationNoticeText: { color: '#A76F67', fontSize: 12, lineHeight: 18 },
  manualLocationPanel: { borderRadius: 16, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 10, gap: 8, marginBottom: 9 },
  locationInput: { borderColor: '#D8EAF8', marginBottom: 0 },
  coordinateRow: { flexDirection: 'row', gap: 8 },
  coordinateInput: { flex: 1, borderColor: '#D8EAF8', marginBottom: 0 },
  manualLocationActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  composerActions: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  secondaryAction: { minHeight: 40, borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#FFE0D7', borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13 },
  secondaryActionText: { color: '#C96E63', fontSize: 12, fontWeight: '700' },
  primaryAction: { minHeight: 42, borderRadius: 14, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, flex: 1 },
  primaryActionText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  disabledAction: { opacity: 0.45 },
  loader: { marginTop: 24 },
  memoryCard: { borderRadius: 20, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 12, marginBottom: 11 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  cardImage: { width: 78, height: 78, borderRadius: 16, backgroundColor: '#F6E4DD' },
  imagePlaceholder: { width: 78, height: 78, borderRadius: 16, backgroundColor: '#F8ECE7', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  imagePlaceholderText: { color: '#B99183', fontSize: 11, textAlign: 'center', lineHeight: 16 },
  cardCopy: { flex: 1, minWidth: 0, gap: 3 },
  cardTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  cardMeta: { color: colors.muted, fontSize: 11 },
  cardPlace: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  entryJourneyChip: { alignSelf: 'flex-start', color: '#9A6D63', backgroundColor: '#FFF0EA', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, fontSize: 10, fontWeight: '800' },
  deleteButton: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF0EA' },
  deleteText: { color: '#D27A6D', fontSize: 12, fontWeight: '800' },
  expanded: { marginTop: 12, gap: 10 },
  noteText: { color: colors.ink, fontSize: 14, lineHeight: 22 },
  mutedText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  detailImage: { width: '100%', height: 190, borderRadius: 17, backgroundColor: '#F6E4DD' },
  locationPanel: { borderRadius: 17, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 11, gap: 5 },
  locationTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  locationText: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  compactMap: { height: 150, borderRadius: 14, marginTop: 6 },
  entryDetailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  memorySyncText: { alignSelf: 'flex-start', color: '#5683A9', backgroundColor: '#E6F3FF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 5, fontSize: 11, fontWeight: '700' },
  emptyState: { borderRadius: 20, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 20, alignItems: 'center', marginTop: 8 },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', marginBottom: 6, textAlign: 'center' },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  mapPage: { flex: 1, paddingBottom: 4 },
  overviewMap: { flex: 1, borderRadius: 20 },
  emptyMap: { flex: 1, borderRadius: 20, backgroundColor: '#FFFFFF', borderColor: '#D8EAF8', borderWidth: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(23, 20, 19, 0.92)', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(43, 36, 33, 0.42)', justifyContent: 'center', padding: 22 },
  modalBackdropPressable: { flex: 1, justifyContent: 'center' },
  modalCard: { borderRadius: 20, backgroundColor: '#FFF9F4', borderColor: '#FFE0D7', borderWidth: 1, padding: 16 },
  modalTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', marginBottom: 13 },
  journeyDescriptionInput: { minHeight: 92, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 9 },
  pickerCard: { maxHeight: '78%', borderRadius: 20, backgroundColor: '#FFF9F4', borderColor: '#FFE0D7', borderWidth: 1, padding: 16 },
  pickerScroll: { maxHeight: 360 },
  pickerRow: { minHeight: 54, borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#F0E0D9', borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8 },
  pickerRowActive: { backgroundColor: '#FFF0EA', borderColor: '#F2B9AA' },
  pickerRowCopy: { flex: 1, minWidth: 0 },
  pickerRowTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  pickerRowMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  pickerCheck: { color: '#C96E63', fontSize: 11, fontWeight: '800' },
  newJourneyFromPicker: { minHeight: 42, borderRadius: 14, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  newJourneyFromPickerText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  batchPage: { flex: 1, backgroundColor: '#FFF9F4', paddingHorizontal: 18 },
  batchHeader: { height: 58, flexDirection: 'row', alignItems: 'center', gap: 12 },
  batchTitle: { color: colors.ink, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  batchContent: { paddingTop: 12, paddingBottom: 18 },
  batchEntryRow: { minHeight: 68, borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, marginBottom: 9 },
  batchEntryRowSelected: { backgroundColor: '#FFF0EA', borderColor: '#F1B8AA' },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderColor: '#D7C3BB', borderWidth: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  checkboxSelected: { backgroundColor: '#EE8D7D', borderColor: '#EE8D7D' },
  checkboxText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  batchEntryCopy: { flex: 1, minWidth: 0 },
  batchEntryTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  batchEntryMeta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  batchConfirmButton: { minHeight: 50, borderRadius: 16, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center' },
  batchConfirmText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});

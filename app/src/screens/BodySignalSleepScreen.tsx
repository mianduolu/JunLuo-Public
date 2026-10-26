import { useCallback, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BodySignalSleepView } from '../bodySignal/BodySignalSleepView';
import { useBodySignalSleepSnapshot } from '../bodySignal/useBodySignalSleepSnapshot';
import { useSleepHeartRateSnapshot } from '../bodySignal/useSleepHeartRateSnapshot';
import { SleepHeartRateSection } from '../bodySignal/SleepHeartRateSection';
import type { Navigate } from '../types/navigation';
import type { BodyDataDestination } from '../bodySignal/BodyDataFeature';

export function BodySignalSleepScreen({ navigate, initialDeviceProfileId, onOpenBodyData }: {
  navigate: Navigate; initialDeviceProfileId?: string;
  onOpenBodyData?(destination: BodyDataDestination): void;
}) {
  const [device, setDevice] = useState(initialDeviceProfileId);
  const snapshot = useBodySignalSleepSnapshot(device);
  const heartRate = useSleepHeartRateSnapshot(snapshot.data?.deviceProfileId, snapshot.data);
  const goBack = useCallback(() => onOpenBodyData ? onOpenBodyData({ section: 'sleep', deviceProfileId: snapshot.data?.deviceProfileId }) : navigate('period'), [navigate, onOpenBodyData, snapshot.data?.deviceProfileId]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { goBack(); return true; });
    return () => subscription.remove();
  }, [goBack]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#F7FAF5' }}>
    <BodySignalSleepView key={snapshot.data?.deviceProfileId ?? device ?? 'empty'} {...snapshot}
      renderHeartRate={dateKey => <SleepHeartRateSection key={`${snapshot.data?.deviceProfileId}:${dateKey}`} dateKey={dateKey} snapshot={heartRate} />}
      selectDevice={setDevice} goBack={goBack} />
  </SafeAreaView>;
}

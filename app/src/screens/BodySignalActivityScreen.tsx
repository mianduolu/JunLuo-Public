import { useCallback, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BodySignalActivityView } from '../bodySignal/BodySignalActivityView';
import { useBodySignalActivitySnapshot } from '../bodySignal/useBodySignalActivitySnapshot';
import type { Navigate } from '../types/navigation';
import type { BodyDataDestination } from '../bodySignal/BodyDataFeature';

export function BodySignalActivityScreen({ navigate, onOpenBodyData }: { navigate: Navigate; onOpenBodyData?(destination: BodyDataDestination): void }) {
  const [device, setDevice] = useState<string>();
  const snapshot = useBodySignalActivitySnapshot(device, { readOnly: true });
  const goBack = useCallback(() => onOpenBodyData ? onOpenBodyData({ section: 'activity', deviceProfileId: snapshot.data?.deviceProfileId }) : navigate('period'), [navigate, onOpenBodyData, snapshot.data?.deviceProfileId]);
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { goBack(); return true; });
    return () => back.remove();
  }, [goBack]);
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#F7FAF5' }}>
    <BodySignalActivityView {...snapshot} navigate={navigate} selectDevice={setDevice} goBack={goBack} />
  </SafeAreaView>;
}

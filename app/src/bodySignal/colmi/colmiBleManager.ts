import { BleManager } from 'react-native-ble-plx';

let manager: BleManager | null = null;

export function getColmiBleManager(): BleManager | null {
  if (manager) return manager;
  try {
    manager = new BleManager();
    return manager;
  } catch {
    return null;
  }
}

export function destroyColmiBleManagerForTests(): void {
  if (manager) {
    void manager.destroy();
    manager = null;
  }
}

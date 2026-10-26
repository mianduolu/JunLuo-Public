type FastRefreshClient = {
  disable(): void;
  enable(): void;
};

export function pauseFastRefreshForBackupRestore() {
  if (!__DEV__) return () => undefined;

  try {
    const hmrModule = require('react-native/Libraries/Utilities/HMRClient') as {
      default?: FastRefreshClient;
    } & Partial<FastRefreshClient>;
    const client = (hmrModule.default ?? hmrModule) as FastRefreshClient;
    if (typeof client.disable !== 'function' || typeof client.enable !== 'function') {
      return () => undefined;
    }

    client.disable();
    console.info('[backup-restore] Fast Refresh paused');
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      try {
        client.enable();
        console.info('[backup-restore] Fast Refresh resumed');
      } catch {
        // A manual reload restores the development connection if Metro changed meanwhile.
      }
    };
  } catch {
    return () => undefined;
  }
}

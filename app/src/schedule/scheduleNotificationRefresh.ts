let refreshTimer: ReturnType<typeof setTimeout> | undefined;

// Several records can change together during a plan save or synchronization.
export function requestScheduleNotificationRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void import('./scheduleNotifications')
      .then(({ syncScheduleNotifications }) => syncScheduleNotifications())
      .catch((error) => console.warn('[schedule-reminder] refresh failed', error));
  }, 0);
}

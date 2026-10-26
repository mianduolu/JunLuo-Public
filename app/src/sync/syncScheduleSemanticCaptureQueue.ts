type ScheduleSemanticOperationRunner = <T>(work: () => Promise<T>) => Promise<T>;
let scheduleSemanticOperationRunner: ScheduleSemanticOperationRunner = work => work();

// The phone uses the direct default; Windows binds its existing native scope.
export function bindScheduleSemanticOperationRunner(runner: ScheduleSemanticOperationRunner) {
  scheduleSemanticOperationRunner = runner;
}

export function runScheduleSemanticOperation<T>(work: () => Promise<T>) {
  return scheduleSemanticOperationRunner(work);
}

let scheduleSemanticCaptureQueue = Promise.resolve();

export function runScheduleSemanticCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  return runScheduleSemanticOperation(() => {
    const current = scheduleSemanticCaptureQueue
      .catch(() => undefined)
      .then(callback);
    scheduleSemanticCaptureQueue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  });
}
let alarmStoreMutationQueue: Promise<unknown> = Promise.resolve();

export function runAlarmStoreMutation<T>(work: () => Promise<T>): Promise<T> {
  const result = alarmStoreMutationQueue.then(work, work);
  alarmStoreMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

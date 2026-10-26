let phoneActivityDatabaseOperationTail: Promise<void> = Promise.resolve();

export function runSerializedPhoneActivityDatabaseOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = phoneActivityDatabaseOperationTail.then(operation);
  phoneActivityDatabaseOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

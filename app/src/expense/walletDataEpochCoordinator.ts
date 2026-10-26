export type WalletDataEpochCommitResult<T> =
  | { committed: false }
  | { committed: true; value: T };

export type WalletDataEpochCoordinator = {
  captureDataEpoch: () => number | null;
  runDataEpochCommit: <T>(
    dataEpoch: number | null,
    work: () => Promise<T>,
  ) => Promise<WalletDataEpochCommitResult<T>>;
};

export async function runWalletDataEpochOperation<TPrepared, TCommitted>({
  commit,
  coordinator,
  dataEpoch,
  prepare,
}: {
  commit: (prepared: TPrepared) => Promise<TCommitted>;
  coordinator: WalletDataEpochCoordinator;
  dataEpoch?: number | null;
  prepare: () => Promise<TPrepared>;
}): Promise<WalletDataEpochCommitResult<TCommitted>> {
  const operationDataEpoch = dataEpoch === undefined
    ? coordinator.captureDataEpoch()
    : dataEpoch;
  if (operationDataEpoch === null) return { committed: false };

  const prepared = await prepare();
  return coordinator.runDataEpochCommit(
    operationDataEpoch,
    () => commit(prepared),
  );
}

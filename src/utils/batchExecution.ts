const activeBatches = new Set<string>();

export class BatchAlreadyRunningError extends Error {
  constructor(key: string) {
    super(`Batch is already running: ${key}`);
    this.name = 'BatchAlreadyRunningError';
  }
}

export async function runExclusiveBatch<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (activeBatches.has(key)) {
    throw new BatchAlreadyRunningError(key);
  }

  activeBatches.add(key);
  try {
    return await task();
  } finally {
    activeBatches.delete(key);
  }
}

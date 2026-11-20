import type { ThreadChannel } from 'discord.js';

interface ArchiveOptions {
  openReason: string;
  closeReason: string;
  afterSuccess: 'archive' | 'restore' | 'deleted';
  forceOpen?: boolean;
}

export async function withTemporaryThreadUnarchive(
  thread: ThreadChannel,
  options: ArchiveOptions,
  action: () => Promise<unknown>,
): Promise<{ error: unknown } | undefined> {
  const wasArchived = options.forceOpen || thread.archived === true;
  if (wasArchived) {
    await thread.setArchived(false, options.openReason);
  }

  let completed = false;
  let archiveFailure: { error: unknown } | undefined;
  try {
    await action();
    completed = true;
  } finally {
    const shouldArchive =
      (completed && options.afterSuccess === 'archive') ||
      (wasArchived && (!completed || options.afterSuccess === 'restore'));
    if (shouldArchive && typeof thread.setArchived === 'function') {
      try {
        await thread.setArchived(true, options.closeReason);
      } catch (error) {
        archiveFailure = { error };
        console.warn(`[ForumArchive] Failed to archive thread #${thread.name} (${thread.id}):`, error);
      }
    }
  }
  return archiveFailure;
}

import { escapeMarkdown, type MessageCreateOptions } from 'discord.js';
import type { Assignment } from './webClass.js';

const heading = '締切が7日以内のWebClass課題（日本時間）';
export const ASSIGNMENT_MESSAGE_HEADING = '**' + heading + '**';
const deadlineFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Tokyo',
  dateStyle: 'short',
  timeStyle: 'short',
});

export function formatAssignmentMessage(
  assignments: readonly Assignment[]
): Pick<MessageCreateOptions, 'content' | 'files' | 'allowedMentions'> {
  const allowedMentions: MessageCreateOptions['allowedMentions'] = { parse: [] };
  if (!assignments.length) {
    return { content: `${ASSIGNMENT_MESSAGE_HEADING}\n該当する課題はありません。`, allowedMentions };
  }

  const fields = assignments.map(({ course, title, deadline }) => [
    course.replace(/\s+/g, ' ').trim(),
    title.replace(/\s+/g, ' ').trim(),
    deadlineFormat.format(deadline),
  ]);
  const rows = fields.map((row, i) => `${i + 1}. ${row.map((field) => escapeMarkdown(field)).join(' ｜ ')}`);
  const content = [ASSIGNMENT_MESSAGE_HEADING, ...rows].join('\n');
  if (content.length <= 2000) {
    return { content, allowedMentions };
  }

  const text = [heading, ...fields.map((row, i) => `${i + 1}. ${row.join(' ｜ ')}`)].join('\n');
  return {
    content: `${ASSIGNMENT_MESSAGE_HEADING}（${assignments.length}件）`,
    files: [{ attachment: Buffer.from(text), name: 'webclass-kadai.txt' }],
    allowedMentions,
  };
}

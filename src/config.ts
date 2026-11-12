import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const configSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  GUILD_ID: z.string().min(1, 'GUILD_ID is required'),
  CATEGORY_ID: z.string().min(1, 'CATEGORY_ID is required'),
  EXCLUDED_FORUM_IDS: z.string().default(''),
  FORUM_INACTIVE_DAYS: z.coerce.number().int().min(1).default(21),
  PORT: z.coerce.number().default(8080),
  TZ: z.string().default('Asia/Tokyo'),
});

export type Config = z.infer<typeof configSchema>;

export function parseExcludedForumIds(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

let currentConfig: Config | null = null;

export function getConfig(): Config {
  if (!currentConfig) {
    const result = configSchema.safeParse(process.env);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ');
      throw new Error(`Environment configuration error: ${issues}`);
    }
    currentConfig = result.data;
  }
  return currentConfig;
}

export function setConfig(customConfig: Config): void {
  currentConfig = customConfig;
}

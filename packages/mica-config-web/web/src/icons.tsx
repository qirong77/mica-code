import type { LucideIcon } from 'lucide-react';
import { Blocks, Braces, Cable, MessagesSquare, RefreshCw, Save, Sparkles } from 'lucide-react';

export const appIcons = {
  config: Braces,
  conversation: MessagesSquare,
  mcp: Cable,
  skills: Sparkles,
  plugins: Blocks,
  refresh: RefreshCw,
  save: Save,
} satisfies Record<string, LucideIcon>;

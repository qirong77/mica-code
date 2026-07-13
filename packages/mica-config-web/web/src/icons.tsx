import type { LucideIcon } from 'lucide-react';
import { Blocks, Braces, Cable, ChevronRight, MessagesSquare, RefreshCw, Save, Sparkles } from 'lucide-react';

export const appIcons = {
  config: Braces,
  conversation: MessagesSquare,
  mcp: Cable,
  skills: Sparkles,
  plugins: Blocks,
  chevronRight: ChevronRight,
  refresh: RefreshCw,
  save: Save,
} satisfies Record<string, LucideIcon>;

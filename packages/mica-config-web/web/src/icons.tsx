import type { LucideIcon } from 'lucide-react';
import {
  Blocks,
  Braces,
  Cable,
  ChevronRight,
  ContactRound,
  History,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
} from 'lucide-react';

export const appIcons = {
  config: Braces,
  sessions: History,
  roles: ContactRound,
  mcp: Cable,
  skills: Sparkles,
  plugins: Blocks,
  chevronRight: ChevronRight,
  add: Plus,
  refresh: RefreshCw,
  save: Save,
} satisfies Record<string, LucideIcon>;

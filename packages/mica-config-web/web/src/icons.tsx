import type { LucideIcon } from 'lucide-react';
import {
  Blocks,
  Braces,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  ContactRound,
  History,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
} from 'lucide-react';

export const appIcons = {
  config: Braces,
  sessions: History,
  roles: ContactRound,
  mcp: Cable,
  skills: Sparkles,
  plugins: Blocks,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  add: Plus,
  refresh: RefreshCw,
  save: Save,
  search: Search,
} satisfies Record<string, LucideIcon>;

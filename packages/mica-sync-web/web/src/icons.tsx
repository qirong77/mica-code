import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Menu,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';

export const appIcons = {
  bot: Bot,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  loader: Loader2,
  menu: Menu,
  refresh: RefreshCw,
  send: Send,
  square: Square,
  sparkles: Sparkles,
  x: X,
} satisfies Record<string, LucideIcon>;

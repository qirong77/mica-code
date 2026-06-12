import { atom } from 'nanostores';

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectPath?: string;
  starred?: boolean;
}

export const session = {
  index: atom<SessionMeta[]>([]),
  currentId: atom<string>(''),
  switchSignal: atom<string | null>(null),
};

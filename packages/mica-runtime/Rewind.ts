export type RewindFileAction = 'restore' | 'delete';

export type RewindFileChange = {
  path: string;
  action: RewindFileAction;
};

export type RewindPreviewResult =
  | {
      ok: true;
      id: string;
      conversationLabel: string;
      createdAt: string;
      messageCountBefore: number;
      messageCountNow: number;
      fileStateAvailable: boolean;
      fileStateError?: string;
      files: RewindFileChange[];
    }
  | { ok: false; message: string };

export type RewindApplyResult = {
  id: string;
  conversationLabel: string;
  messageCount: number;
  fileStateAvailable: boolean;
  fileStateError?: string;
  files: RewindFileChange[];
};

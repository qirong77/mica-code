export type RewindFileAction = 'restore' | 'delete';

export type RewindMode = 'conversation_only' | 'conversation_and_files';

export type RewindFileChange = {
  path: string;
  action: RewindFileAction;
};

export type RewindCheckpointSummary = {
  id: string;
  conversationLabel: string;
  createdAt: string;
  messageCountBefore: number;
};

export type RewindApplyRequest = {
  id: string;
  mode: RewindMode;
  previewToken: string;
};

export type RewindPreviewResult =
  | (RewindCheckpointSummary & {
      ok: true;
      messageCountNow: number;
      fileStateAvailable: boolean;
      fileStateError?: string;
      files: RewindFileChange[];
      previewToken: string;
    })
  | { ok: false; message: string };

export type RewindApplyResult = {
  id: string;
  mode: RewindMode;
  conversationLabel: string;
  inputText: string;
  messageCountBefore: number;
  messageCountNow: number;
  messageCountRemoved: number;
  conversationMessagesBefore: unknown[];
  fileStateAvailable: boolean;
  fileStateError?: string;
  files: RewindFileChange[];
  postApplyWarning?: string;
};

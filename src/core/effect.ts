import { contextSizeAtom, estimateContextSize, messagesAtom } from '../store/conversation.js';

messagesAtom.subscribe((messages) => {
  contextSizeAtom.set(estimateContextSize([...messages]));
});

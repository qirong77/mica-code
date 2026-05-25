import { contextSizeAtom, estimateContextSize, messagesAtom } from "src/store/conversation";

messagesAtom.subscribe((messages) => {
    contextSizeAtom.set(estimateContextSize([...messages]));
});
import {$isLinkNode} from '@lexical/link';
import {LINK, type TextMatchTransformer} from '@lexical/markdown';
import {$createTextNode} from 'lexical';

/** Notebook typing follows Yuque's `[label](URL)` + Space. Import/export still
 * use the standard LINK transformer, including balanced URLs and link titles. */
export const NOTEBOOK_LINK_SHORTCUT: TextMatchTransformer = {
  ...LINK,
  trigger: ' ',
  regExp: new RegExp(LINK.regExp!.source.replace(/\$$/, ' $'), LINK.regExp!.flags),
  replace: (node, match) => {
    const text = LINK.replace?.(node, match);
    const link = text?.getParent();
    if (!$isLinkNode(link)) return;
    // Keep the typed space outside the link so subsequent typing is plain text.
    link.insertAfter($createTextNode(' ')).selectEnd();
    return text;
  },
};

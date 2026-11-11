import {Button, Empty} from '@arco-design/web-react';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {TableOfContentsPlugin} from '@lexical/react/LexicalTableOfContentsPlugin';
import {useState} from 'react';

export default function WorkspaceOutline() {
  const [editor] = useLexicalComposerContext();
  const [active, setActive] = useState('');
  return (
    <TableOfContentsPlugin>
      {headings => <nav className="workspace-outline" aria-label="文档大纲">
        {headings.length === 0 && <Empty description="添加标题，自动生成大纲" />}
        {headings.map(([key, text, level]) => <Button
          key={key}
          type="text"
          className={`outline-link ${active === key ? 'is-active' : ''} outline-${level}`}
          title={text || '未命名标题'}
          onClick={() => {
            editor.getElementByKey(key)?.scrollIntoView({behavior: 'smooth', block: 'center'});
            setActive(key);
          }}>
          <span className="outline-marker" />
          <span>{text || '未命名标题'}</span>
        </Button>)}
      </nav>}
    </TableOfContentsPlugin>
  );
}

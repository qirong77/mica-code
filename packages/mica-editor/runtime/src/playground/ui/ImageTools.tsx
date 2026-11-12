import './ImageTools.css';

import {Button, InputNumber, Switch} from '@arco-design/web-react';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconDelete,
  IconEdit,
  IconExpand,
  IconImage,
  IconLink,
  IconLock,
  IconMore,
  IconRefresh,
  IconRotateRight,
  IconScissor,
  IconShrink,
  IconUnlock,
} from '@arco-design/web-react/icon';
import {autoUpdate, flip, hide, offset, shift, useFloating} from '@floating-ui/react';
import {type RefObject, useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {MenuSeparator} from '../../../../../mica-config-ui/web/components/ActionMenu';
import DropDown, {DropDownItem} from './DropDown';
import Modal from './Modal';
import TextInput from './TextInput';

export type ImageAction =
  | 'rotate'
  | 'crop'
  | 'size'
  | 'description'
  | 'link'
  | 'replace'
  | 'reset'
  | 'preview'
  | 'delete';
export type ImageAlignment = 'left' | 'center' | 'right';

export function ImageToolbar({
  anchor,
  buttonRef,
  alignment,
  showCaption,
  captionsEnabled,
  busy,
  broken,
  onAction,
  onAlign,
  onDismiss,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  alignment: ImageAlignment;
  showCaption: boolean;
  captionsEnabled: boolean;
  busy: boolean;
  broken: boolean;
  onAction: (action: ImageAction) => void;
  onAlign: (alignment: ImageAlignment) => void;
  onDismiss: () => void;
}) {
  const {refs, floatingStyles, middlewareData} = useFloating({
    placement: 'top-start',
    strategy: 'fixed',
    middleware: [
      offset(10),
      flip({padding: {top: 54, bottom: 36, left: 10, right: 10}}),
      shift({padding: 10}),
      hide(),
    ],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    refs.setReference(anchor.current);
  }, [anchor, refs]);
  const alignments = [
    {value: 'left' as const, label: '左对齐', icon: <IconAlignLeft />},
    {value: 'center' as const, label: '居中', icon: <IconAlignCenter />},
    {value: 'right' as const, label: '右对齐', icon: <IconAlignRight />},
  ];
  const action = (id: ImageAction, label: string, icon: React.ReactNode, iconOnly = true) => (
    <Button
      key={id}
      type="text"
      size="mini"
      icon={icon}
      aria-label={label}
      title={label}
      disabled={busy || (broken && !['replace', 'delete', 'description', 'link'].includes(id))}
      onClick={() => onAction(id)}>
      {!iconOnly && <span>{label}</span>}
    </Button>
  );
  const ownerDocument = anchor.current?.ownerDocument;
  if (!ownerDocument) return null;
  return createPortal(
    <div
      ref={refs.setFloating}
      style={{
        ...floatingStyles,
        visibility: middlewareData.hide?.referenceHidden ? 'hidden' : undefined,
      }}
      className="image-toolbar"
      role="toolbar"
      aria-label="图片工具栏"
      onMouseDown={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}>
      <div className="image-toolbar-group">
        <Button
          ref={buttonRef}
          type="text"
          size="mini"
          icon={<IconRotateRight />}
          aria-label="顺时针旋转"
          title="顺时针旋转 90°"
          disabled={busy || broken}
          onClick={() => onAction('rotate')}
        />
        {action('crop', '裁剪图片', <IconScissor />)}
        {action('size', '宽高', <IconExpand />, false)}
      </div>
      <div className="image-toolbar-group">
        {action('link', '图片链接', <IconLink />)}
        {action('description', '描述', <IconEdit />, false)}
      </div>
      <div className="image-toolbar-group">
        <DropDown
          disabled={busy}
          buttonClassName="image-tool-dropdown"
          buttonAriaLabel="图片对齐"
          buttonIcon={alignments.find(item => item.value === alignment)?.icon}>
          {alignments.map(item => (
            <DropDownItem
              key={item.value}
              className={`item wide${alignment === item.value ? ' active' : ''}`}
              onClick={() => onAlign(item.value)}>
              <span className="icon-text-container">
                {item.icon}
                <span className="text">{item.label}</span>
              </span>
            </DropDownItem>
          ))}
        </DropDown>
        {action('preview', '预览图片', <IconExpand />)}
        <DropDown
          disabled={busy}
          buttonClassName="image-tool-dropdown"
          buttonAriaLabel="图片更多操作"
          hideChevron
          buttonIcon={<IconMore />}>
          <DropDownItem className="item wide" onClick={() => onAction('replace')}>
            <span className="icon-text-container">
              <IconImage />
              <span className="text">替换图片</span>
            </span>
          </DropDownItem>
          <DropDownItem disabled={broken} className="item wide" onClick={() => onAction('reset')}>
            <span className="icon-text-container">
              <IconRefresh />
              <span className="text">恢复原始尺寸</span>
            </span>
          </DropDownItem>
          {captionsEnabled && (
            <DropDownItem
              className={`item wide${showCaption ? ' active' : ''}`}
              onClick={() => onAction('description')}>
              <span className="icon-text-container">
                <IconEdit />
                <span className="text">
                  {showCaption ? '编辑图片描述与图注' : '添加图片描述与图注'}
                </span>
              </span>
            </DropDownItem>
          )}
          <MenuSeparator />
          <DropDownItem className="item wide image-delete-item" onClick={() => onAction('delete')}>
            <span className="icon-text-container">
              <IconDelete />
              <span className="text">删除图片</span>
            </span>
          </DropDownItem>
        </DropDown>
      </div>
    </div>,
    ownerDocument.body,
  );
}

function ImagePopover({
  anchor,
  title,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  title: string;
  onClose: (restoreFocus?: boolean) => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const {refs, floatingStyles, middlewareData} = useFloating({
    placement: 'top-start',
    strategy: 'fixed',
    middleware: [
      offset(12),
      flip({padding: {top: 50, bottom: 12, left: 10, right: 10}}),
      shift({padding: 10}),
      hide(),
    ],
    whileElementsMounted: autoUpdate,
  });
  useEffect(() => {
    refs.setReference(anchor.current);
  }, [anchor, refs]);
  useEffect(() => {
    const doc = anchor.current?.ownerDocument;
    if (!doc) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    const onBlur = () => onClose(false);
    doc.defaultView?.addEventListener('blur', onBlur);
    panelRef.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.defaultView?.removeEventListener('blur', onBlur);
    };
  }, [anchor, onClose]);
  const ownerDocument = anchor.current?.ownerDocument;
  if (!ownerDocument) return null;
  return createPortal(
    <div
      ref={node => {
        panelRef.current = node;
        refs.setFloating(node);
      }}
      style={{
        ...floatingStyles,
        visibility: middlewareData.hide?.referenceHidden ? 'hidden' : undefined,
      }}
      className="image-settings-popover"
      role="dialog"
      aria-label={title}
      onMouseDown={event => event.stopPropagation()}>
      <div className="image-settings-popover-title">{title}</div>
      {children}
    </div>,
    ownerDocument.body,
  );
}

export function ImageSizePopover({
  anchor,
  width,
  height,
  maxWidth,
  onApply,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  width: number;
  height: number;
  maxWidth: number;
  onApply: (width: number, height: number) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const [size, setSize] = useState({width: Math.round(width), height: Math.round(height)});
  const [locked, setLocked] = useState(true);
  const [ratio, setRatio] = useState(width / height || 1);
  const widthId = useId(),
    heightId = useId();
  const change = (field: 'width' | 'height', value: number | undefined) => {
    if (!Number.isFinite(value)) return;
    setSize(previous =>
      locked
        ? field === 'width'
          ? {width: value!, height: Math.max(1, Math.round(value! / ratio))}
          : {height: value!, width: Math.max(1, Math.round(value! * ratio))}
        : {...previous, [field]: value!},
    );
  };
  const valid =
    size.width >= 1 && size.width <= maxWidth && size.height >= 1 && size.height <= 16384;
  const apply = () => {
    if (valid) {
      onApply(size.width, size.height);
      onClose();
    }
  };
  return (
    <ImagePopover anchor={anchor} title="图片宽高" onClose={onClose}>
      <div
        onKeyDown={event => {
          // The editor's sandbox blocks native form submissions, including submit events.
          if (
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            apply();
          }
        }}>
        <div className="image-size-fields">
          <label htmlFor={widthId}>
            宽度 <span>px</span>
            <InputNumber
              id={widthId}
              aria-label="图片宽度"
              autoFocus
              min={1}
              max={Math.floor(maxWidth)}
              precision={0}
              value={size.width}
              onChange={value => change('width', value)}
            />
          </label>
          <Button
            type="text"
            icon={locked ? <IconLock /> : <IconUnlock />}
            aria-label="锁定宽高比"
            aria-pressed={locked}
            title={locked ? '取消锁定宽高比' : '锁定宽高比'}
            onClick={() => {
              setRatio(size.width / size.height || 1);
              setLocked(value => !value);
            }}
          />
          <label htmlFor={heightId}>
            高度 <span>px</span>
            <InputNumber
              id={heightId}
              aria-label="图片高度"
              min={1}
              max={16384}
              precision={0}
              value={size.height}
              onChange={value => change('height', value)}
            />
          </label>
        </div>
        <p className="image-settings-hint">
          {locked ? '修改宽高时保持图片比例' : '宽度和高度可分别调整'} · 正文可用宽度{' '}
          {Math.floor(maxWidth)} px
        </p>
        <div className="image-size-presets">
          <Button
            size="small"
            type="text"
            onClick={() => {
              const next = Math.round(maxWidth / 2);
              setSize({width: next, height: Math.round(next / ratio)});
            }}>
            半栏宽
          </Button>
          <Button
            size="small"
            type="text"
            onClick={() =>
              setSize({width: Math.floor(maxWidth), height: Math.round(maxWidth / ratio)})
            }>
            适应正文
          </Button>
        </div>
        <div className="image-settings-actions">
          <Button onClick={() => onClose()}>取消</Button>
          <Button type="primary" disabled={!valid} onClick={apply}>
            应用
          </Button>
        </div>
      </div>
    </ImagePopover>
  );
}

export function ImageDescriptionPopover({
  anchor,
  altText,
  showCaption,
  captionsEnabled,
  onApply,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  altText: string;
  showCaption: boolean;
  captionsEnabled: boolean;
  onApply: (altText: string, showCaption: boolean) => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const [description, setDescription] = useState(altText);
  const [caption, setCaption] = useState(showCaption);
  const captionId = useId();
  const apply = () => {
    onApply(description, caption);
    onClose();
  };
  return (
    <ImagePopover anchor={anchor} title="图片描述" onClose={onClose}>
      <div
        onKeyDown={event => {
          if (
            event.key === 'Enter' &&
            !event.nativeEvent.isComposing &&
            event.target instanceof HTMLInputElement
          ) {
            event.preventDefault();
            apply();
          }
        }}>
        <TextInput
          label="图片描述"
          placeholder="简要描述图片内容，供无障碍阅读或加载失败时显示"
          value={description}
          onChange={setDescription}
          autoFocus
        />
        {captionsEnabled && (
          <div className="image-caption-setting">
            <label id={captionId}>显示图注</label>
            <Switch
              size="small"
              aria-labelledby={captionId}
              checked={caption}
              onChange={setCaption}
            />
          </div>
        )}
        <p className="image-settings-hint">图注在图片下方编辑；关闭图注会保留已有文字。</p>
        <div className="image-settings-actions">
          <Button onClick={() => onClose()}>取消</Button>
          <Button type="primary" onClick={apply}>
            应用
          </Button>
        </div>
      </div>
    </ImagePopover>
  );
}

export function ImagePreviewDialog({
  src,
  altText,
  onClose,
}: {
  src: string;
  altText: string;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <Modal
      title="图片预览"
      onClose={onClose}
      closeOnClickOutside
      className="image-preview-modal"
      style={{width: 'min(1120px, calc(100vw - 32px))'}}>
      <div className={`image-preview-stage${zoomed ? ' is-zoomed' : ''}`}>
        <img src={src} alt={altText} onDoubleClick={() => setZoomed(value => !value)} />
      </div>
      <div className="image-preview-footer">
        <span title={altText}>{altText || '图片预览'}</span>
        <Button
          type="text"
          size="small"
          icon={zoomed ? <IconShrink /> : <IconExpand />}
          onClick={() => setZoomed(value => !value)}>
          {zoomed ? '适应窗口' : '原始大小'}
        </Button>
      </div>
    </Modal>
  );
}

import type {JSX, KeyboardEvent, PointerEvent} from 'react';

import './ImageCropDialog.css';

import {Button, InputNumber, Radio} from '@arco-design/web-react';
import {useEffect, useId, useRef, useState} from 'react';

import {DialogActions} from './Dialog';
import {
  clampCrop,
  cropImage,
  getCropOutputSize,
  type ImageCropRect,
  type ImageTransformResult,
} from './imageTransform';
import Modal from './Modal';

type Point = {x: number; y: number};
type ImageSize = {width: number; height: number};
type Aspect = 'original' | 'free' | '1:1' | '4:3' | '16:9';
type Corner = 'nw' | 'ne' | 'sw' | 'se';
type Drag = {
  pointerId: number;
  mode: 'create' | 'move' | 'resize';
  start: Point;
  anchor: Point;
  crop: ImageCropRect;
};

const FULL_CROP: ImageCropRect = {x: 0, y: 0, width: 1, height: 1};
const ASPECT_OPTIONS = [
  {value: 'original', label: '原比例'},
  {value: 'free', label: '自由'},
  {value: '1:1', label: '1:1'},
  {value: '4:3', label: '4:3'},
  {value: '16:9', label: '16:9'},
];
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

function limit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizedAspect(aspect: Aspect, size: ImageSize): number | null {
  if (aspect === 'free') {
    return null;
  }
  if (aspect === 'original') {
    return 1;
  }
  const [width, height] = aspect.split(':').map(Number);
  return (width / height) / (size.width / size.height);
}

function centeredCrop(crop: ImageCropRect, width: number, height: number): ImageCropRect {
  const scale = Math.min(1, 1 / width, 1 / height);
  width *= scale;
  height *= scale;
  return clampCrop({
    x: limit(crop.x + crop.width / 2 - width / 2, 0, 1 - width),
    y: limit(crop.y + crop.height / 2 - height / 2, 0, 1 - height),
    width,
    height,
  });
}

function cropFromPoints(
  anchor: Point,
  point: Point,
  ratio: number | null,
  size: ImageSize,
): ImageCropRect | null {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const signX = dx === 0 ? (anchor.x > 0.5 ? -1 : 1) : Math.sign(dx);
  const signY = dy === 0 ? (anchor.y > 0.5 ? -1 : 1) : Math.sign(dy);
  const maxWidth = signX < 0 ? anchor.x : 1 - anchor.x;
  const maxHeight = signY < 0 ? anchor.y : 1 - anchor.y;
  let width = Math.max(1 / size.width, Math.abs(dx));
  let height = Math.max(1 / size.height, Math.abs(dy));
  if (ratio !== null) {
    width = Math.max(width, height * ratio);
    height = width / ratio;
    const scale = Math.min(1, maxWidth / width, maxHeight / height);
    width *= scale;
    height *= scale;
  } else {
    width = Math.min(width, maxWidth);
    height = Math.min(height, maxHeight);
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return clampCrop({
    x: signX < 0 ? anchor.x - width : anchor.x,
    y: signY < 0 ? anchor.y - height : anchor.y,
    width,
    height,
  });
}

export default function ImageCropDialog({src, altText, onApply, onClose}: {
  src: string;
  altText: string;
  onApply: (result: ImageTransformResult) => boolean | Promise<boolean>;
  onClose: () => void;
}): JSX.Element {
  const [imageSize, setImageSize] = useState<ImageSize | null>(null);
  const [crop, setCrop] = useState<ImageCropRect>(FULL_CROP);
  const [aspect, setAspect] = useState<Aspect>('original');
  const [viewport, setViewport] = useState({width: 640, height: 400});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const mountedRef = useRef(false);
  const closedRef = useRef(false);
  const applyingRef = useRef(false);
  const operationRef = useRef(0);
  const sourceRef = useRef(src);
  sourceRef.current = src;
  const descriptionId = useId();
  const widthId = useId();
  const heightId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      dragRef.current = null;
    };
  }, []);

  useEffect(() => {
    operationRef.current += 1;
    applyingRef.current = false;
    dragRef.current = null;
    setImageSize(null);
    setCrop(FULL_CROP);
    setAspect('original');
    setBusy(false);
    setError('');
    setLoadFailed(false);
  }, [src]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const measure = () => {
      const width = Math.max(1, stage.clientWidth - 24);
      const height = Math.max(1, stage.clientHeight - 24);
      setViewport((previous) => previous.width === width && previous.height === height
        ? previous
        : {width, height});
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  function close() {
    if (closedRef.current) {
      return;
    }
    closedRef.current = true;
    operationRef.current += 1;
    dragRef.current = null;
    onClose();
  }

  function pointAt(event: PointerEvent<HTMLDivElement>): Point | null {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: limit((event.clientX - rect.left) / rect.width, 0, 1),
      y: limit((event.clientY - rect.top) / rect.height, 0, 1),
    };
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!imageSize || busy || !event.isPrimary || event.button !== 0) {
      return;
    }
    const start = pointAt(event);
    if (!start) {
      return;
    }
    const target = event.target as HTMLElement;
    const corner = target.closest<HTMLElement>('[data-crop-corner]')?.dataset.cropCorner as Corner | undefined;
    const full = crop.width === 1 && crop.height === 1;
    const move = !corner && !full && Boolean(target.closest('.image-crop-selection'));
    const anchor = corner ? {
      x: corner.includes('w') ? crop.x + crop.width : crop.x,
      y: corner.includes('n') ? crop.y + crop.height : crop.y,
    } : start;
    dragRef.current = {
      pointerId: event.pointerId,
      mode: corner ? 'resize' : move ? 'move' : 'create',
      start,
      anchor,
      crop,
    };
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({preventScroll: true});
    event.currentTarget.setPointerCapture(event.pointerId);
    setError('');
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !imageSize || busy) {
      return;
    }
    const point = pointAt(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    if (drag.mode === 'move') {
      setCrop({
        ...drag.crop,
        x: limit(drag.crop.x + point.x - drag.start.x, 0, 1 - drag.crop.width),
        y: limit(drag.crop.y + point.y - drag.start.y, 0, 1 - drag.crop.height),
      });
    } else if (point.x !== drag.start.x || point.y !== drag.start.y) {
      const next = cropFromPoints(drag.anchor, point, normalizedAspect(aspect, imageSize), imageSize);
      if (next) {
        setCrop(next);
      }
    }
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    if (cancelled) {
      setCrop(drag.crop);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function moveWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!imageSize || busy || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const directions: Record<string, Point> = {
      ArrowLeft: {x: -1, y: 0},
      ArrowRight: {x: 1, y: 0},
      ArrowUp: {x: 0, y: -1},
      ArrowDown: {x: 0, y: 1},
    };
    const direction = directions[event.key];
    if (!direction) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    setCrop((previous) => ({
      ...previous,
      x: limit(previous.x + direction.x * step / imageSize.width, 0, 1 - previous.width),
      y: limit(previous.y + direction.y * step / imageSize.height, 0, 1 - previous.height),
    }));
  }

  function changeAspect(value: Aspect) {
    if (!imageSize || busy) {
      return;
    }
    setAspect(value);
    const ratio = normalizedAspect(value, imageSize);
    if (ratio !== null) {
      const width = Math.min(crop.width, crop.height * ratio);
      setCrop(centeredCrop(crop, width, width / ratio));
    }
    setError('');
  }

  function changeDimension(axis: 'width' | 'height', value: number) {
    if (!imageSize || busy || !Number.isFinite(value) || value < 1) {
      return;
    }
    let width = axis === 'width' ? limit(Math.round(value) / imageSize.width, 1 / imageSize.width, 1) : crop.width;
    let height = axis === 'height' ? limit(Math.round(value) / imageSize.height, 1 / imageSize.height, 1) : crop.height;
    const ratio = normalizedAspect(aspect, imageSize);
    if (ratio !== null) {
      if (axis === 'width') {
        height = width / ratio;
      } else {
        width = height * ratio;
      }
    }
    setCrop(centeredCrop(crop, width, height));
    setError('');
  }

  async function apply() {
    if (!imageSize || applyingRef.current || closedRef.current) {
      return;
    }
    applyingRef.current = true;
    const operation = ++operationRef.current;
    const source = src;
    const active = () => mountedRef.current && !closedRef.current &&
      operationRef.current === operation && sourceRef.current === source;
    setBusy(true);
    setError('');
    try {
      const result = await cropImage(source, crop);
      if (!active()) {
        return;
      }
      const applied = await onApply(result);
      if (!active()) {
        return;
      }
      if (applied) {
        close();
      } else {
        setError('图片已发生变化，无法应用裁剪，请关闭后重试。');
      }
    } catch (reason) {
      if (active()) {
        setError(reason instanceof Error ? reason.message : '裁剪失败，请重试。');
      }
    } finally {
      if (active()) {
        applyingRef.current = false;
        setBusy(false);
      }
    }
  }

  const scale = imageSize ? Math.min(1, viewport.width / imageSize.width, viewport.height / imageSize.height) : 0;
  const outputSize = imageSize ? getCropOutputSize(imageSize.width, imageSize.height, crop) : null;
  const selectionWidth = imageSize ? Math.min(imageSize.width - Math.min(imageSize.width - 1, Math.round(crop.x * imageSize.width)), Math.max(1, Math.round(crop.width * imageSize.width))) : 0;
  const selectionHeight = imageSize ? Math.min(imageSize.height - Math.min(imageSize.height - 1, Math.round(crop.y * imageSize.height)), Math.max(1, Math.round(crop.height * imageSize.height))) : 0;
  const resized = outputSize && (outputSize.width < selectionWidth || outputSize.height < selectionHeight);

  return (
    <Modal title="裁剪图片" onClose={close} className="image-crop-modal"
      style={{width: 'min(720px, calc(100vw - 32px))'}}>
      <div className="image-crop-dialog" aria-busy={busy} onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}>
        <div className="image-crop-controls">
          <div className="image-crop-ratios">
            <span className="image-crop-label">裁剪比例</span>
            <Radio.Group type="button" size="small" value={aspect} options={ASPECT_OPTIONS}
              disabled={!imageSize || busy} aria-label="裁剪比例"
              onChange={(value: Aspect) => changeAspect(value)} />
          </div>
          <div className="image-crop-dimensions">
            <div className="image-crop-size-field">
              <label htmlFor={widthId}>宽度（像素）</label>
              <InputNumber id={widthId} size="small" mode="button" min={1} max={imageSize?.width}
                precision={0} value={selectionWidth || undefined} disabled={!imageSize || busy}
                onChange={(value) => changeDimension('width', Number(value))} />
            </div>
            <div className="image-crop-size-field">
              <label htmlFor={heightId}>高度（像素）</label>
              <InputNumber id={heightId} size="small" mode="button" min={1} max={imageSize?.height}
                precision={0} value={selectionHeight || undefined} disabled={!imageSize || busy}
                onChange={(value) => changeDimension('height', Number(value))} />
            </div>
          </div>
        </div>

        <div className="image-crop-stage" ref={stageRef}>
          {!imageSize && <span className="image-crop-load-status">{loadFailed ? '暂无预览' : '正在加载图片…'}</span>}
          <div className="image-crop-preview" ref={surfaceRef} role="group" aria-label="图片裁剪选区"
            aria-describedby={descriptionId} aria-disabled={!imageSize || busy}
            tabIndex={imageSize && !busy ? 0 : -1}
            style={{width: imageSize ? imageSize.width * scale : 0, height: imageSize ? imageSize.height * scale : 0}}
            onPointerDown={startDrag} onPointerMove={moveDrag}
            onPointerUp={finishDrag} onPointerCancel={(event) => finishDrag(event, true)}
            onLostPointerCapture={() => { dragRef.current = null; }} onKeyDown={moveWithKeyboard}>
            <img key={src} src={src} alt={altText || '待裁剪图片'} draggable={false}
              onLoad={(event) => {
                if (closedRef.current || sourceRef.current !== src) {
                  return;
                }
                const {naturalWidth: width, naturalHeight: height} = event.currentTarget;
                if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                  setImageSize({width, height});
                  setLoadFailed(false);
                } else {
                  setLoadFailed(true);
                  setError('图片尺寸无效，无法裁剪这张图片。');
                }
              }}
              onError={() => {
                if (!closedRef.current && sourceRef.current === src) {
                  setImageSize(null);
                  setLoadFailed(true);
                  setError('图片加载失败，请检查图片链接后重试。');
                }
              }} />
            {imageSize && <>
              <div className="image-crop-shade" style={{left: 0, top: 0, width: '100%', height: `${crop.y * 100}%`}} />
              <div className="image-crop-shade" style={{left: 0, top: `${(crop.y + crop.height) * 100}%`, width: '100%', bottom: 0}} />
              <div className="image-crop-shade" style={{left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%`}} />
              <div className="image-crop-shade" style={{left: `${(crop.x + crop.width) * 100}%`, top: `${crop.y * 100}%`, right: 0, height: `${crop.height * 100}%`}} />
              <div className="image-crop-selection" data-full={crop.width === 1 && crop.height === 1}
                style={{left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`}}>
                <div className="image-crop-grid" aria-hidden="true" />
                {CORNERS.map((corner) => <span key={corner} aria-hidden="true"
                  className={`image-crop-corner image-crop-corner-${corner}`} data-crop-corner={corner} />)}
              </div>
            </>}
          </div>
        </div>

        <p className="image-crop-instructions" id={descriptionId}>
          拖动框选或调整四角，拖动选区移动。方向键微调，按住 Shift 加速。
        </p>
        {error && <p className="image-crop-error" role="alert">{error}</p>}
        <div className="image-crop-footer">
          <span className="image-crop-output" aria-live="polite">
            {outputSize ? `输出 ${outputSize.width} × ${outputSize.height} 像素${resized ? '（已等比缩小）' : ''}` : '等待图片加载'}
          </span>
          <DialogActions>
            <Button htmlType="button" type="text" size="small" disabled={!imageSize || busy} onClick={() => {
              dragRef.current = null;
              setCrop(FULL_CROP);
              setAspect('original');
              setError('');
            }}>重置</Button>
            <Button htmlType="button" size="small" onClick={close}>取消</Button>
            <Button htmlType="button" type="primary" size="small" disabled={!imageSize || busy}
              loading={busy} onClick={() => { void apply(); }}>应用</Button>
          </DialogActions>
        </div>
      </div>
    </Modal>
  );
}

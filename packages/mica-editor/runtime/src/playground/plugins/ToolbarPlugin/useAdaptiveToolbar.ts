import {type RefObject, useLayoutEffect, useRef, useState} from 'react';

export type ToolbarGroup = {
  id: string;
  section: string;
  priority?: number;
};

/** Keep required groups, then try optional groups from highest to lowest priority. */
export function fitToolbarGroups(
  groups: Array<ToolbarGroup & {width: number}>,
  availableWidth: number,
  gap: number,
  sectionGap: number,
): Set<string> {
  const visible = new Set(
    groups.filter(group => group.priority === undefined).map(group => group.id),
  );
  const candidates = groups
    .map((group, index) => ({group, index}))
    .filter(({group}) => group.priority !== undefined)
    .sort(
      (left, right) =>
        (left.group.priority ?? 0) - (right.group.priority ?? 0) ||
        left.index - right.index,
    );

  const visibleWidth = () => {
    let width = 0;
    let previous: ToolbarGroup | undefined;
    for (const group of groups) {
      if (!visible.has(group.id)) {
        continue;
      }
      if (previous) {
        width += gap;
        if (previous.section !== group.section) {
          width += sectionGap;
        }
      }
      width += group.width;
      previous = group;
    }
    return width;
  };

  for (const {group} of candidates) {
    visible.add(group.id);
    if (visibleWidth() > availableWidth) {
      visible.delete(group.id);
    }
  }

  return new Set(
    groups.filter(group => !visible.has(group.id)).map(group => group.id),
  );
}

function readPixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function sameIds(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(id => right.has(id));
}

export function useAdaptiveToolbar(
  groups: ToolbarGroup[],
  layoutKey?: string,
): {
  toolbarElementRef: RefObject<HTMLDivElement | null>;
  overflowed: Set<string>;
} {
  const toolbarElementRef = useRef<HTMLDivElement>(null);
  const [overflowed, setOverflowed] = useState<Set<string>>(() => new Set());
  // Callers can recreate the array on every render without resubscribing.
  const groupSignature = JSON.stringify(
    groups.map(({id, section, priority}) => [id, section, priority ?? null]),
  );

  useLayoutEffect(() => {
    const toolbar = toolbarElementRef.current;
    const ownerWindow = toolbar?.ownerDocument.defaultView;
    if (!toolbar || !ownerWindow) {
      return;
    }

    const definitions = (
      JSON.parse(groupSignature) as Array<[string, string, number | null]>
    ).map(([id, section, priority]): ToolbarGroup => ({
      id,
      section,
      priority: priority ?? undefined,
    }));
    let disposed = false;

    const measure = () => {
      if (disposed) {
        return;
      }
      const previousMeasuring = toolbar.getAttribute('data-measuring');
      let next: Set<string>;
      try {
        // CSS reveals every group and removes section margins for intrinsic widths.
        toolbar.setAttribute('data-measuring', 'true');
        const style = ownerWindow.getComputedStyle(toolbar);
        const availableWidth = Math.max(
          0,
          toolbar.clientWidth -
            readPixels(style.paddingLeft) -
            readPixels(style.paddingRight),
        );
        const widths = new Map<string, number>();
        for (const child of toolbar.children) {
          const id = child.getAttribute('data-toolbar-group');
          if (id !== null) {
            widths.set(id, child.getBoundingClientRect().width);
          }
        }
        const measuredGroups = definitions.flatMap(group => {
          const width = widths.get(group.id);
          return width === undefined ? [] : [{...group, width}];
        });
        next = fitToolbarGroups(
          measuredGroups,
          availableWidth,
          readPixels(style.getPropertyValue('--toolbar-group-gap')),
          readPixels(style.getPropertyValue('--toolbar-section-gap')),
        );
      } finally {
        if (previousMeasuring === null) {
          toolbar.removeAttribute('data-measuring');
        } else {
          toolbar.setAttribute('data-measuring', previousMeasuring);
        }
      }
      setOverflowed(previous => (sameIds(previous, next) ? previous : next));
    };

    measure();

    let observedWidth: number | undefined;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(entries => {
            const entry = entries.find(item => item.target === toolbar);
            if (!entry || entry.contentRect.width === observedWidth) {
              return;
            }
            observedWidth = entry.contentRect.width;
            measure();
          });
    // Content-box changes also cover padding updates from the editor host.
    observer?.observe(toolbar, {box: 'content-box'});

    const fonts = toolbar.ownerDocument.fonts;
    fonts?.addEventListener('loadingdone', measure);
    void fonts?.ready.then(measure);

    return () => {
      disposed = true;
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', measure);
    };
  }, [groupSignature, layoutKey]);

  return {toolbarElementRef, overflowed};
}

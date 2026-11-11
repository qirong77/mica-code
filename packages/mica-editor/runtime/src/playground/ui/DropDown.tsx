/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {Button} from '@arco-design/web-react';
import {calculateZoomLevel} from '@lexical/utils';
import {
  getComposedEventTarget,
  isDOMNode,
  registerEventListener,
} from 'lexical';
import * as React from 'react';
import {
  type JSX,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {createPortal} from 'react-dom';

import {MenuItem, MenuList} from '../../../../../mica-config-ui/web/components/ActionMenu';
import {isKeyboardInput} from '../utils/focusUtils';

const dropDownPadding = 6;

export function DropDownItem({
  children,
  className,
  onClick,
  title,
  disabled,
}: {
  children: React.ReactNode;
  className: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <MenuItem
      className={className}
      selected={/(^|\s)active(\s|$)/.test(className) || undefined}
      disabled={disabled}
      onClick={onClick}
      title={title}>
      {children}
    </MenuItem>
  );
}

export default function DropDown({
  disabled = false,
  buttonLabel,
  buttonAriaLabel,
  buttonClassName,
  buttonIconClassName,
  children,
  stopCloseOnClickSelf,
  hideChevron,
  title,
  buttonStyle,
  onOpen,
}: {
  disabled?: boolean;
  buttonAriaLabel?: string;
  buttonClassName: string;
  buttonIconClassName?: string;
  buttonLabel?: string;
  children: ReactNode;
  stopCloseOnClickSelf?: boolean;
  hideChevron?: boolean;
  title?: string;
  buttonStyle?: CSSProperties;
  onOpen?: () => void;
}): JSX.Element {
  const dropDownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [showDropDown, setShowDropDown] = useState(false);

  const handleClose = () => {
    setShowDropDown(false);
    if (buttonRef && buttonRef.current) {
      buttonRef.current.focus();
    }
  };

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const dropDown = dropDownRef.current;
    if (!showDropDown || button === null || dropDown === null) return;
    const updatePosition = () => {
      // Container resizing can move this tool into More without a window resize.
      if (!button.getClientRects().length) {
        setShowDropDown(false);
        return;
      }
      const zoom = calculateZoomLevel(dropDown, true);
      const {top, bottom, left} = button.getBoundingClientRect();
      const menuHeight = dropDown.getBoundingClientRect().height;
      const menuWidth = dropDown.getBoundingClientRect().width;
      const below = bottom + dropDownPadding;
      const menuTop =
        below + menuHeight <= window.innerHeight - 8
          ? below
          : Math.max(8, top - menuHeight - dropDownPadding);
      dropDown.style.top = `${menuTop / zoom}px`;
      dropDown.style.left = `${Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8)) / zoom}px`;
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(button);
    observer.observe(dropDown);
    return () => observer.disconnect();
  }, [dropDownRef, buttonRef, showDropDown, children]);

  useEffect(() => {
    const button = buttonRef.current;

    if (button !== null && showDropDown) {
      const handle = (event: PointerEvent) => {
        // A menu can replace its content with a deeper set of choices.
        if (event.defaultPrevented) return;
        // click bubbles up from a shadow tree with event.target retargeted
        // to the shadow host, which would make button.contains(target) false
        // and immediately close the dropdown. Use the composed-path target.
        const target = getComposedEventTarget(event);
        if (!isDOMNode(target)) {
          return;
        }

        const targetIsDropDownItem =
          dropDownRef.current && dropDownRef.current.contains(target);
        if (stopCloseOnClickSelf && targetIsDropDownItem) {
          return;
        }

        if (!button.contains(target)) {
          setShowDropDown(false);

          if (targetIsDropDownItem && isKeyboardInput(event)) {
            button.focus();
          }
        }
      };
      const doc = button.ownerDocument;
      return registerEventListener(doc, 'click', handle);
    }
  }, [dropDownRef, buttonRef, showDropDown, stopCloseOnClickSelf]);

  useEffect(() => {
    const button = buttonRef.current;
    if (button === null) {
      return;
    }

    const handleButtonPositionUpdate = (event: Event) => {
      // A compact toolbar scrolls horizontally on narrow screens. Do not leave
      // its body-portal menu behind, but allow the menu itself to scroll.
      if (
        isDOMNode(event.target) &&
        dropDownRef.current?.contains(event.target)
      )
        return;
      setShowDropDown(false);
    };

    if (!showDropDown) return;
    const stopScroll = registerEventListener(
      button.ownerDocument,
      'scroll',
      handleButtonPositionUpdate,
      true,
    );
    const stopResize = registerEventListener(
      window,
      'resize',
      handleButtonPositionUpdate,
    );
    // Pointer events in the host do not bubble out of this sandbox document.
    // Leaving the frame must dismiss its menu just like clicking outside it.
    const stopBlur = registerEventListener(window, 'blur', () => setShowDropDown(false));
    return () => {
      stopScroll();
      stopResize();
      stopBlur();
    };
  }, [buttonRef, dropDownRef, showDropDown]);

  const handleOnClick = () => {
    if (!showDropDown) onOpen?.();
    setShowDropDown(visible => !visible);
  };

  return (
    <>
      <Button
        htmlType="button"
        type="text"
        disabled={disabled}
        aria-label={buttonAriaLabel || buttonLabel}
        aria-expanded={showDropDown}
        aria-haspopup="menu"
        title={title || buttonAriaLabel || buttonLabel}
        style={buttonStyle}
        className={buttonClassName}
        onClick={handleOnClick}
        ref={buttonRef}>
        {buttonIconClassName && <span className={buttonIconClassName} />}
        {buttonLabel && (
          <span className="text dropdown-button-text">{buttonLabel}</span>
        )}
        {!hideChevron && <i className="chevron-down" />}
      </Button>

      {showDropDown &&
        createPortal(
          <MenuList
            className="editor-dropdown"
            aria-label={buttonAriaLabel || buttonLabel}
            ref={dropDownRef}
            onClose={handleClose}
            autoFocus>
            {children}
          </MenuList>,
          buttonRef.current?.ownerDocument?.body ?? document.body,
        )}
    </>
  );
}

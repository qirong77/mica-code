import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatComposer from './ChatComposer'

describe('ChatComposer', () => {
  it('renders native text and placeholder with only a hidden decorative cursor', () => {
    const textareaRef = { current: null }
    const props = { value: 'hello\n你好 👩‍💻', placeholder: 'Write here', textareaRef }
    const tree = ChatComposer(props)
    const [textarea] = tree.props.children

    expect(tree.type).toBe('div')
    expect(tree.props.className).toBe('chat-composer-input')
    expect(textarea.type).toBe('textarea')
    expect(textarea.props).toMatchObject({
      ref: textareaRef,
      value: props.value,
      placeholder: props.placeholder,
      rows: 1,
      spellCheck: false,
      autoCapitalize: 'off',
      autoCorrect: 'on',
      autoComplete: 'off',
      'aria-label': '对话输入'
    })
    expect(renderToStaticMarkup(createElement(ChatComposer, props))).toBe(
      '<div class="chat-composer-input"><textarea placeholder="Write here" rows="1" spellCheck="false" autoCapitalize="off" autoCorrect="on" autoComplete="off" aria-label="对话输入">hello\n你好 👩‍💻</textarea><span class="chat-composer-cursor" aria-hidden="true" hidden=""></span></div>'
    )
    const empty = renderToStaticMarkup(createElement(ChatComposer, { ...props, value: '' }))
    expect(empty).toContain('placeholder="Write here"')
    expect(empty).toContain('</textarea><span')
  })

  it('forwards the current textarea value as a string', () => {
    const values = []
    const [textarea] = ChatComposer({ value: '', onChange: (value) => values.push(value) }).props
      .children

    textarea.props.onChange({ currentTarget: { value: '新的草稿\nnext line' } })
    expect(values).toEqual(['新的草稿\nnext line'])
  })

  it('forwards ordinary keys unchanged and leaves composition keys to the native input', () => {
    const events = []
    const [textarea] = ChatComposer({ value: '', onKeyDown: (event) => events.push(event) }).props
      .children
    const enter = { key: 'Enter', keyCode: 13, nativeEvent: { isComposing: false } }
    const shiftEnter = { ...enter, shiftKey: true }
    const arrow = { key: 'ArrowDown', keyCode: 40, nativeEvent: { isComposing: false } }

    for (const event of [enter, shiftEnter, arrow]) textarea.props.onKeyDown(event)
    textarea.props.onKeyDown({ ...enter, nativeEvent: { isComposing: true } })
    textarea.props.onKeyDown({ ...enter, keyCode: 229 })

    expect(events).toEqual([enter, shiftEnter, arrow])
    expect(events[0]).toBe(enter)
  })

  it('passes focus and paste handlers directly to the textarea', () => {
    const onFocus = () => {}
    const onPaste = () => {}
    const [textarea] = ChatComposer({ value: '', onFocus, onPaste }).props.children

    expect(textarea.props.onFocus).toBe(onFocus)
    expect(textarea.props.onPaste).toBe(onPaste)
  })
})

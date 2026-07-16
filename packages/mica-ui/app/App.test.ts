import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box } from '@anthropic/ink';
import { App } from './App.js';

describe('App terminal mode', () => {
  it('uses the normal terminal screen as its root', () => {
    const root = App() as React.ReactElement;

    expect(root.type).toBe(Box);
  });
});

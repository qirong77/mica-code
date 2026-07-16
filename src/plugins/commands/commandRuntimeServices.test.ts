import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaUi } from '@packages/mica-ui/index.js';
import { createCommandRuntimeServices } from './commandRuntimeServices.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('command runtime exit service', () => {
  it('awaits the application-owned exit flow without forcing the process to exit', async () => {
    const requestExit = vi.spyOn(micaUi.terminalInput, 'requestExit').mockResolvedValue();
    const processExit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const services = createCommandRuntimeServices();

    await services.requestExit(7);

    expect(requestExit).toHaveBeenCalledWith(7);
    expect(processExit).not.toHaveBeenCalled();
  });
});

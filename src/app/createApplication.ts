import { Application } from './Application.js';

export function createApplication(options: { sessionId?: string } = {}): Application {
  return new Application(options);
}

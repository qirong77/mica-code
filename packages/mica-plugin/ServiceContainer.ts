import type { Disposable } from '@packages/mica-common/index.js';
import type { ServiceToken } from './ServiceToken.js';

export class ServiceContainer {
  private readonly services = new Map<string, unknown>();

  register<T>(token: ServiceToken<T>, service: T): Disposable {
    if (this.services.has(token.id)) {
      throw new Error(`Service already registered: ${token.id}`);
    }

    this.services.set(token.id, service);

    return {
      dispose: () => {
        if (this.services.get(token.id) === service) {
          this.services.delete(token.id);
        }
      },
    };
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.services.has(token.id)) {
      throw new Error(`Service not registered: ${token.id}`);
    }
    return this.services.get(token.id) as T;
  }

  optional<T>(token: ServiceToken<T>): T | undefined {
    return this.services.get(token.id) as T | undefined;
  }
}

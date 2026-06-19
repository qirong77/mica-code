export type Disposable = {
  dispose(): void | Promise<void>;
};

export function toDisposable(dispose: () => void | Promise<void>): Disposable {
  return { dispose };
}

export class DisposableStore implements Disposable {
  private readonly disposables: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(disposable: T): T {
    if (this.disposed) {
      void disposable.dispose();
      return disposable;
    }
    this.disposables.push(disposable);
    return disposable;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const disposables = this.disposables.splice(0).reverse();
    for (const disposable of disposables) {
      await disposable.dispose();
    }
  }
}

/**
 * Minimal type declarations for node-pty (its bundled typings are not declared
 * in package.json). Covers only the APIs used by mica-pty.
 */
declare module 'node-pty' {
  export interface IPtyForkOptions {
    /** Name of the terminal, sets $TERM. */
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
    encoding?: string | null;
    uid?: number;
    gid?: number;
  }

  export interface IPty {
    readonly pid: number;
    /** Subscribe to output chunks; returns an unsubscribe function. */
    onData(cb: (data: string) => void): void;
    /** Subscribe to process exit. */
    onExit(cb: (info: { exitCode: number; signal?: number }) => void): void;
    /** Write raw bytes to the child's stdin. */
    write(data: string): void;
    /** Resize the PTY window. */
    resize(cols: number, rows: number): void;
    /** Kill the child process. */
    kill(signal?: string): void;
  }

  export function spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
}

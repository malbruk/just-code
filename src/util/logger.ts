import * as vscode from 'vscode';

/** Thin wrapper around an OutputChannel for structured host-side logging. */
export class Logger {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'Just Code') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  private write(level: string, args: unknown[]): void {
    const time = new Date().toISOString();
    const parts = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    });
    const line = `[${time}] [${level}] ${parts.join(' ')}`;
    this.channel.appendLine(line);
    // Mirror to the Debug Console so activation is visible during `F5` too.
    const c = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    c(`[Just Code] ${parts.join(' ')}`);
  }

  info(...args: unknown[]): void {
    this.write('info', args);
  }

  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  error(...args: unknown[]): void {
    this.write('error', args);
  }

  /** Raw passthrough, e.g. for SDK stderr. */
  raw(data: string): void {
    this.channel.append(data);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}

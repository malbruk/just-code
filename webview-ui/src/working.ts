/**
 * The "assistant is working" indicator shown at the tail of a streaming turn:
 * the product mark, then a gerund that is typed out one character at a time,
 * held, erased and swapped for another, trailed by a caret — mirroring Claude
 * Code's status line.
 *
 * The element is created once per streaming turn and *moved* between blocks as
 * the transcript reconciles (`appendChild` relocates a live node), so the typing
 * animation never restarts mid-turn. Its timer is owned here and keeps running
 * while the node is detached, which is exactly what makes that possible.
 */
import { logo } from './logo.js';

/** Whimsical gerunds, Claude Code style. Only ever rendered LTR. */
const WORDS = [
  'Generating',
  'Thinking',
  'Working',
  'Cooking',
  'Crafting',
  'Pondering',
  'Noodling',
  'Percolating',
  'Simmering',
  'Brewing',
  'Computing',
  'Wrangling',
  'Tinkering',
  'Musing',
  'Puzzling',
  'Deliberating',
  'Synthesizing',
  'Assembling',
  'Conjuring',
  'Herding',
  'Riffing',
  'Marinating',
];

const TYPE_MS = 55;
const ERASE_MS = 26;
const HOLD_MS = 1600;
const GAP_MS = 260;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export class WorkingIndicator {
  readonly el: HTMLElement;
  private readonly wordEl: HTMLElement;
  private timer: number | undefined;
  private word = '';
  private wordIndex = -1;
  private chars = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'working';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.el.innerHTML =
      `<span class="working-logo">${logo(12)}</span>` +
      `<span class="working-word"></span>` +
      `<span class="working-caret" aria-hidden="true"></span>`;
    this.wordEl = this.el.querySelector('.working-word')!;

    if (prefersReducedMotion()) this.wordEl.textContent = 'Working';
    else this.nextWord();
  }

  /**
   * While characters are moving, hold the caret solid — a caret that blinks and
   * slides at the same time is what reads as stutter. It only blinks once the
   * word settles.
   */
  private setTyping(on: boolean): void {
    this.el.classList.toggle('typing', on);
  }

  /** Stop the animation and take the node out of the transcript. */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.el.remove();
  }

  private schedule(ms: number, fn: () => void): void {
    this.timer = window.setTimeout(fn, ms);
  }

  /** Pick a word other than the one just shown, then type it. */
  private nextWord(): void {
    let i = Math.floor(Math.random() * WORDS.length);
    if (i === this.wordIndex) i = (i + 1) % WORDS.length;
    this.wordIndex = i;
    this.word = WORDS[i];
    this.chars = 0;
    this.type();
  }

  private type(): void {
    this.chars++;
    this.wordEl.textContent = this.word.slice(0, this.chars);
    this.setTyping(true);
    if (this.chars < this.word.length) return this.schedule(TYPE_MS, () => this.type());
    this.setTyping(false);
    this.schedule(HOLD_MS, () => this.erase());
  }

  private erase(): void {
    this.chars--;
    this.wordEl.textContent = this.word.slice(0, Math.max(0, this.chars));
    this.setTyping(true);
    if (this.chars > 0) return this.schedule(ERASE_MS, () => this.erase());
    this.setTyping(false);
    this.schedule(GAP_MS, () => this.nextWord());
  }
}

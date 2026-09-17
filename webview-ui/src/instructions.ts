/**
 * The "Instructions" dialog, opened from the header's shield button or with
 * `/instructions`.
 *
 * Extension-wide (not per-conversation) configuration of the instructions the
 * agent gets: base instructions only, or the selected *work profile* (exactly
 * one at a time — its system prompt applies to new chats) plus that profile's
 * on-demand *instruction prompts*, with a checkbox per prompt and a per-prompt
 * "activate automatically" toggle. The host owns the data and persists it into
 * the `just-code.instructionsMode` / `just-code.activeProfile` /
 * `just-code.instructionPrompts` / `just-code.autoActivatePrompts` settings
 * (`requestInstructionSettings` / `updateInstructionSettings` →
 * `instructionSettings`); this module owns only presentation. Changes apply to
 * new chats.
 */
import type { InstructionSettings, InstructionsMode } from '@just-code/core';
import { escapeHtml } from './markdown.js';
import { close as closeIcon } from './icons.js';

export interface InstructionsDialogCallbacks {
  /** Ask the host for the current settings (the dialog opens on a spinner). */
  onRequest: () => void;
  /** Persist a change; the host echoes back an `instructionSettings`. */
  onUpdate: (mode: InstructionsMode, activeProfile: string, disabled: string[], auto: string[]) => void;
}

/** The settings key of a prompt — ids are only unique within their profile. */
const key = (profileId: string, promptId: string) => `${profileId}/${promptId}`;

export class InstructionsDialog {
  readonly root: HTMLElement;
  private settings: InstructionSettings | undefined;

  constructor(private readonly cb: InstructionsDialogCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'acct-overlay';
    this.root.hidden = true;

    this.root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // The transparent backdrop dismisses; clicks inside the panel do not.
      if (target === this.root || target.closest('[data-instr="close"]')) {
        this.close();
        return;
      }
      if (!this.settings) return;
      const mode = target.closest('[data-mode]');
      if (mode) {
        this.setMode(mode.getAttribute('data-mode') as InstructionsMode);
        return;
      }
      const profile = target.closest<HTMLInputElement>('input[data-select-profile]');
      if (profile) {
        this.setActiveProfile(profile.getAttribute('data-select-profile')!);
        return;
      }
      const auto = target.closest<HTMLInputElement>('input[data-auto]');
      if (auto) {
        this.setAuto(auto.getAttribute('data-auto')!, auto.checked);
        return;
      }
      const box = target.closest<HTMLInputElement>('input[data-prompt]');
      if (box) this.setPrompt(box.getAttribute('data-prompt')!, box.checked);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Open on a spinner and ask the host to fill it in. */
  open(): void {
    this.settings = undefined;
    this.root.hidden = false;
    this.render();
    this.cb.onRequest();
  }

  close(): void {
    this.root.hidden = true;
  }

  show(settings: InstructionSettings): void {
    this.settings = settings;
    if (!this.root.hidden) this.render();
  }

  /** Optimistically apply a mode change, then persist it. */
  private setMode(mode: InstructionsMode): void {
    const s = this.settings!;
    if (mode === s.mode) return;
    s.mode = mode;
    this.render();
    this.post();
  }

  /** Optimistically switch the selected work profile, then persist it. */
  private setActiveProfile(id: string): void {
    const s = this.settings!;
    if (id === s.activeProfile || !s.profiles.some((p) => p.id === id)) return;
    s.activeProfile = id;
    this.render();
    this.post();
  }

  /** Optimistically apply a prompt-checkbox change, then persist it. */
  private setPrompt(promptKey: string, enabled: boolean): void {
    const prompt = this.find(promptKey);
    if (!prompt) return;
    prompt.enabled = enabled;
    this.render();
    this.post();
  }

  /** Optimistically toggle a prompt's "activate automatically", then persist. */
  private setAuto(promptKey: string, auto: boolean): void {
    const prompt = this.find(promptKey);
    if (!prompt) return;
    prompt.auto = auto;
    this.render();
    this.post();
  }

  /** Resolve a `<profile-id>/<prompt-id>` key back to its view model. */
  private find(promptKey: string) {
    for (const profile of this.settings!.profiles) {
      const prompt = profile.prompts.find((p) => key(profile.id, p.id) === promptKey);
      if (prompt) return prompt;
    }
    return undefined;
  }

  private post(): void {
    const s = this.settings!;
    // Disabled/auto keys are collected across ALL profiles, so switching the
    // active profile never wipes another profile's stored prompt state.
    const disabled: string[] = [];
    const auto: string[] = [];
    for (const profile of s.profiles) {
      for (const p of profile.prompts) {
        if (!p.enabled) disabled.push(key(profile.id, p.id));
        if (p.auto) auto.push(key(profile.id, p.id));
      }
    }
    this.cb.onUpdate(s.mode, s.activeProfile, disabled, auto);
  }

  private panel(body: string): string {
    return (
      `<div class="acct-panel" role="dialog" aria-modal="true" aria-label="Instructions">` +
      `<div class="acct-header">` +
      `<span class="acct-title">Instructions</span>` +
      `<button type="button" class="acct-close" data-instr="close" title="Close" aria-label="Close">${closeIcon()}</button>` +
      `</div>` +
      `<div class="acct-body">${body}</div>` +
      `</div>`
    );
  }

  private render(): void {
    if (!this.settings) {
      this.root.innerHTML = this.panel(
        `<div class="acct-loading"><span class="spinner"></span><span>Loading settings…</span></div>`,
      );
      return;
    }
    const s = this.settings;
    const profilesOn = s.mode === 'profiles';
    const selected = s.profiles.find((p) => p.id === s.activeProfile);

    let body =
      `<div class="acct-section">MODE</div>` +
      `<div class="acct-toggle" role="group" aria-label="Instructions mode">` +
      `<button type="button" class="acct-toggle-btn${!profilesOn ? ' active' : ''}" data-mode="base">Base only</button>` +
      `<button type="button" class="acct-toggle-btn${profilesOn ? ' active' : ''}" data-mode="profiles">Work profile</button>` +
      `</div>` +
      `<div class="acct-note acct-dim" dir="auto">${
        profilesOn
          ? "The agent runs under the selected work profile — its system prompt applies, plus the profile's on-demand instruction prompts it loads when a request matches one."
          : 'The agent runs without a work profile — only the general base principles apply; no instruction prompts are advertised or loadable.'
      }</div>`;

    body += `<div class="acct-section">PROFILE</div>`;
    if (!s.profiles.length) {
      body += `<div class="acct-empty" dir="auto">This build ships no work profiles.</div>`;
    } else {
      body += s.profiles
        .map((p) => {
          const active = p.id === s.activeProfile;
          return (
            `<label class="instr-profile-pick${profilesOn ? '' : ' is-disabled'}">` +
            `<input type="radio" name="instr-profile" data-select-profile="${escapeHtml(p.id)}"` +
            `${active ? ' checked' : ''}${profilesOn ? '' : ' disabled'}>` +
            `<span class="instr-profile-text">` +
            `<span class="instr-profile-name" dir="auto">${escapeHtml(p.name)}</span>` +
            `<span class="instr-profile-desc" dir="auto">${escapeHtml(p.description)}</span>` +
            `</span>` +
            `</label>`
          );
        })
        .join('');
    }

    body += `<div class="acct-section">INSTRUCTION PROMPTS</div>`;
    if (!selected) {
      body += `<div class="acct-empty" dir="auto">No work profile is selected.</div>`;
    } else if (!selected.prompts.length) {
      body += `<div class="acct-empty" dir="auto">This profile ships no instruction prompts.</div>`;
    } else {
      body += selected.prompts
        .map((p) => {
          const k = key(selected.id, p.id);
          const interactive = profilesOn && p.enabled;
          return (
            `<div class="instr-profile-row">` +
            `<label class="instr-profile${profilesOn ? '' : ' is-disabled'}">` +
            `<input type="checkbox" data-prompt="${escapeHtml(k)}"` +
            `${p.enabled ? ' checked' : ''}${profilesOn ? '' : ' disabled'}>` +
            `<span class="instr-profile-text">` +
            `<span class="instr-profile-name" dir="auto">${escapeHtml(p.name)}</span>` +
            `<span class="instr-profile-desc" dir="auto">${escapeHtml(p.description)}</span>` +
            `</span>` +
            `</label>` +
            `<label class="instr-auto${interactive ? '' : ' is-disabled'}">` +
            `<input type="checkbox" data-auto="${escapeHtml(k)}"` +
            `${p.auto ? ' checked' : ''}${interactive ? '' : ' disabled'}>` +
            `<span dir="auto">Activate automatically, without asking</span>` +
            `</label>` +
            `</div>`
          );
        })
        .join('');
    }

    body += `<div class="acct-note acct-dim" dir="auto">Applies to the whole extension, starting with the next new chat.</div>`;

    this.root.innerHTML = this.panel(body);
  }
}

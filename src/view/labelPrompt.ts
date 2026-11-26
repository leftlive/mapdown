// The "Boundary label" prompt (spec 5.15, edit-frame-label): a small modal
// with one text input, prefilled. Enter or Save confirms, Esc or Cancel
// closes without a change. The value goes back as written; the caller
// strips `%` and treats empty as "remove the label".

import { Modal, type App } from "obsidian";
import { t } from "../i18n.ts";
import { DOM } from "./contract.ts";

class LabelPrompt extends Modal {
	private done = false;
	private readonly initial: string;
	private readonly submit: (label: string) => void;
	private readonly closed: () => void;

	constructor(app: App, initial: string, submit: (label: string) => void, closed: () => void) {
		super(app);
		this.initial = initial;
		this.submit = submit;
		this.closed = closed;
	}

	onOpen(): void {
		this.modalEl.addClass(DOM.labelPrompt);
		this.titleEl.setText(t("frame-label-title"));
		const input = this.contentEl.createEl("input", { cls: DOM.labelPromptInput, type: "text" });
		input.value = this.initial;
		input.setAttr("aria-label", t("frame-label-title"));
		input.placeholder = t("frame-label-hint");
		const confirm = (): void => {
			if (this.done) return;
			this.done = true;
			const value = input.value;
			this.close();
			this.submit(value);
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				confirm();
			}
		});
		const row = this.contentEl.createDiv({ cls: "modal-button-container" });
		const save = row.createEl("button", { cls: "mod-cta", text: t("frame-label-save") });
		save.addEventListener("click", confirm);
		const cancel = row.createEl("button", { text: t("Cancel") });
		cancel.addEventListener("click", () => this.close());
		input.win.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
		this.closed();
	}
}

/** Opens the prompt with `initial`; `submit` gets the text when confirmed (never when cancelled); `closed` runs after either. */
export function promptFrameLabel(app: App, initial: string, submit: (label: string) => void, closed: () => void = () => {}): void {
	new LabelPrompt(app, initial, submit, closed).open();
}

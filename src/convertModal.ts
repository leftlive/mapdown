// Asks how to open a note that is not a mind map yet: converting in place
// rewrites it on the first save, a copy leaves it untouched.
import { App, Modal, Setting } from 'obsidian';
import { t } from './i18n.ts';
import { DOM } from './view/contract.ts';

export type ConvertChoice = 'in-place' | 'copy' | null;

export function askConvertMode(app: App, noteName: string): Promise<ConvertChoice> {
    return new Promise((resolve) => {
        let choice: ConvertChoice = null;
        const modal = new Modal(app);
        modal.modalEl.addClass(DOM.convertModal);
        modal.titleEl.setText(t('Open as a mind map?'));
        modal.contentEl.createEl('p', { text: t('Convert note explanation', noteName) });
        new Setting(modal.contentEl)
            .addButton((b) => b.setButtonText(t('Cancel')).onClick(() => modal.close()).buttonEl.setAttribute(DOM.actionAttr, 'cancel'))
            .addButton((b) => b.setButtonText(t('Save as a new mind map')).onClick(() => {
                choice = 'copy';
                modal.close();
            }).buttonEl.setAttribute(DOM.actionAttr, 'save-as-new'))
            .addButton((b) => b.setButtonText(t('Convert this note')).setCta().onClick(() => {
                choice = 'in-place';
                modal.close();
            }).buttonEl.setAttribute(DOM.actionAttr, 'convert'));
        modal.onClose = () => resolve(choice);
        modal.open();
    });
}

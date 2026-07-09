import { api } from 'lwc';
import LightningModal from 'lightning/modal';

export default class FlowLauncherModal extends LightningModal {
    @api flowApiName;
    @api recordId;

    get inputVariables() {
        return this.recordId
            ? [{ name: 'recordId', type: 'String', value: this.recordId }]
            : [];
    }

    handleStatusChange(event) {
        const s = event.detail.status;
        if (s === 'FINISHED' || s === 'FINISHED_SCREEN') {
            this.close('finished');
        }
    }
}

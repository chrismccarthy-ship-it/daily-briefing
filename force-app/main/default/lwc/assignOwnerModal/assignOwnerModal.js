import LightningModal from 'lightning/modal';

export default class AssignOwnerModal extends LightningModal {
    selectedOwnerId;

    handleChange(event) {
        this.selectedOwnerId = event.detail.recordId;
    }
    handleCancel() {
        this.close(null);
    }
    handleAssign() {
        if (this.selectedOwnerId) {
            this.close(this.selectedOwnerId);
        }
    }
    get assignDisabled() {
        return !this.selectedOwnerId;
    }
}

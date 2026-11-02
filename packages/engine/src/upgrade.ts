import { Fault } from './control.js';

/** Coordinates the host process handoff; it never stops a running task or the VM. */
export class UpgradeGate {
  private active = 0;
  private preparing = false;
  admit() {
    return !this.preparing;
  }
  enter() {
    if (this.preparing) throw new Fault('AGENT_UPDATING', 503);
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  prepare(busy: () => boolean) {
    if (this.preparing) throw new Fault('AGENT_UPDATING', 503);
    // Fence first: asynchronous model starts re-check admission before publishing a job.
    this.preparing = true;
    try {
      if (this.active || busy()) throw new Fault('AGENT_UPDATE_BUSY', 409);
    } catch (error) {
      this.preparing = false;
      throw error;
    }
  }
  cancel() {
    this.preparing = false;
  }
}

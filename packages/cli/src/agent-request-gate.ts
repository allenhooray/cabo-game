import type { AgentRequest } from "@cabo/shared";

export class AgentRequestGate {
  private uncertain = false;

  canExecute(request: AgentRequest): boolean {
    return !this.uncertain || !["create", "join", "reconnect", "action"].includes(request.type);
  }

  markTimeout(): void {
    this.uncertain = true;
  }

  markObserved(): void {
    this.uncertain = false;
  }

  get isUncertain(): boolean {
    return this.uncertain;
  }
}

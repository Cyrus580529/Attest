export class PlanRunner {
  readonly goal: string;
  private readonly visitedSet = new Set<string>();
  private readonly synthesis: string[] = [];

  constructor(goal: string) {
    this.goal = goal;
  }

  markVisited(refId: string): void {
    this.visitedSet.add(refId);
  }

  hasVisited(refId: string): boolean {
    return this.visitedSet.has(refId);
  }

  remaining(candidateIds: string[]): string[] {
    return candidateIds.filter((id) => !this.visitedSet.has(id));
  }

  addFinding(text: string): void {
    this.synthesis.push(text);
  }

  summary(): string {
    return this.synthesis.join('\n');
  }

  get visited(): string[] {
    return [...this.visitedSet];
  }
}

export interface CallbackRegistry {
  listTargets(): readonly string[]
  resolve(target: string): string | undefined
}

export class StaticCallbackRegistry implements CallbackRegistry {
  constructor(private readonly targets: ReadonlyMap<string, string>) {}

  listTargets(): readonly string[] {
    return [...this.targets.keys()].sort()
  }

  resolve(target: string): string | undefined {
    return this.targets.get(target)
  }
}

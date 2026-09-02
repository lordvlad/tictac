export type ComponentClass<T extends Component = Component> = (new (
  ...args: never[]
) => T) & {
  readonly componentName: string
}

export abstract class Component {
  abstract get name(): string

  abstract serialize(): Record<string, unknown>
  abstract deserialize(data: Record<string, unknown>): void
}

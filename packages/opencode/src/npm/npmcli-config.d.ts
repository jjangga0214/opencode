declare module "@npmcli/config" {
  type Data = Record<string, unknown>
  type Where = "default" | "builtin" | "global" | "user" | "project" | "env" | "cli"

  export default class Config {
    constructor(input: {
      argv: string[]
      cwd: string
      definitions: Data
      env: NodeJS.ProcessEnv
      execPath: string
      flatten: (input: Data, flat?: Data) => Data
      nerfDarts?: string[]
      npmPath: string
      platform: NodeJS.Platform
      shorthands: Record<string, string[]>
      warn?: boolean
    })

    readonly data: Map<Where, { source: string | null }>
    readonly flat: Data
    load(): Promise<void>
  }
}

declare module "@npmcli/config/lib/definitions" {
  export const definitions: Record<string, unknown>
  export const flatten: (input: Record<string, unknown>, flat?: Record<string, unknown>) => Record<string, unknown>
  export const nerfDarts: string[]
  export const shorthands: Record<string, string[]>
}

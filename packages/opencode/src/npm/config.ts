export * as NpmConfig from "./config"

import { access } from "fs/promises"
import { createRequire } from "module"
import path from "path"
import type Config from "@npmcli/config"
import { Context, Effect, Layer } from "effect"

import { makeRuntime } from "../effect/runtime"

const require = createRequire(import.meta.url)
const npmPath = (() => {
  try {
    return path.dirname(require.resolve("npm/package.json"))
  } catch {
    return path.dirname(require.resolve("@npmcli/config/package.json"))
  }
})()

export type FlatOptions = Record<string, unknown>
type ConfigWhere = "project" | "user" | "global"

export interface ArboristOptions extends FlatOptions {
  readonly path: string
  readonly binLinks: boolean
  readonly progress: boolean
  readonly savePrefix: string
  readonly ignoreScripts: boolean
}

export interface Interface {
  readonly flat: (dir: string) => Effect.Effect<FlatOptions, Error>
  readonly paths: (dir: string) => Effect.Effect<string[], Error>
  readonly arboristOptions: (dir: string) => Effect.Effect<ArboristOptions, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/NpmConfig") {}

const toError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))

const imports = Promise.all([import("@npmcli/config"), import("@npmcli/config/lib/definitions")])

const load = Effect.fnUntraced(function* (dir: string) {
  const [{ default: Config }, { definitions, flatten, nerfDarts, shorthands }] = yield* Effect.tryPromise({
    try: () => imports,
    catch: toError,
  })

  const config = new Config({
    argv: [],
    cwd: dir,
    definitions,
    env: { ...process.env },
    execPath: process.execPath,
    flatten,
    nerfDarts,
    npmPath,
    platform: process.platform,
    shorthands,
    warn: false,
  })

  yield* Effect.tryPromise({
    try: () => config.load(),
    catch: toError,
  })
  return config
})

function source(config: Config, where: ConfigWhere) {
  return config.data.get(where)?.source
}

const exists = (file: string) =>
  Effect.tryPromise({
    try: () => access(file),
    catch: toError,
  }).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flat: Interface["flat"] = Effect.fn("NpmConfig.flat")(function* (dir: string) {
      return (yield* load(dir)).flat as FlatOptions
    })

    const paths: Interface["paths"] = Effect.fn("NpmConfig.paths")(function* (dir: string) {
      const config = yield* load(dir)
      const resolved: Array<string | undefined> = []
      for (const where of ["project", "user", "global"] as const) {
        const file = source(config, where)
        if (!file || !path.isAbsolute(file)) {
          resolved.push(undefined)
          continue
        }
        resolved.push((yield* exists(file)) ? file : undefined)
      }
      return resolved.filter((item): item is string => item !== undefined)
    })

    const arboristOptions: Interface["arboristOptions"] = Effect.fn("NpmConfig.arboristOptions")(function* (
      dir: string,
    ) {
      return {
        ...(yield* flat(dir)),
        path: dir,
        binLinks: true,
        progress: false,
        savePrefix: "",
        ignoreScripts: true,
      }
    })

    return Service.of({
      flat,
      paths,
      arboristOptions,
    })
  }),
)

export const defaultLayer = layer

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function flat(dir: string): Promise<FlatOptions> {
  return runPromise((svc) => svc.flat(dir))
}

export async function paths(dir: string): Promise<string[]> {
  return runPromise((svc) => svc.paths(dir))
}

export async function arboristOptions(dir: string): Promise<ArboristOptions> {
  return runPromise((svc) => svc.arboristOptions(dir))
}

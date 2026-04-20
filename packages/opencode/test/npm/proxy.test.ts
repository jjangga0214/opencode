import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { once } from "node:events"
import fs from "fs/promises"
import { createHash } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "path"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Global } from "@opencode-ai/shared/global"
import { EffectFlock } from "@opencode-ai/shared/util/effect-flock"
import { Npm } from "../../src/npm"
import { NpmConfig } from "../../src/npm/config"
import { tmpdir } from "../fixture/fixture"

const pkg = "proxy-env-confirm"
const version = "1.0.0"

function env(next: Record<string, string | undefined>) {
  const prev = Object.fromEntries(Object.keys(next).map((key) => [key, process.env[key]]))

  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server")
  }
  return address.port
}

async function createTarball(dir: string) {
  const root = path.join(dir, "payload")
  const source = path.join(root, "package")
  const tarball = path.join(dir, `${pkg}-${version}.tgz`)

  await fs.mkdir(source, { recursive: true })
  await Bun.write(
    path.join(source, "package.json"),
    JSON.stringify({ name: pkg, version, main: "index.js" }),
  )
  await Bun.write(path.join(source, "index.js"), "module.exports = { ok: true }\n")
  await $`tar -czf ${tarball} -C ${root} package`.quiet()
  return fs.readFile(tarball)
}

function startRegistry(tarball: Buffer) {
  const hits: string[] = []
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`)
    hits.push(url.pathname)

    if (url.pathname === `/${pkg}`) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          name: pkg,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name: pkg,
              version,
              dist: {
                tarball: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${pkg}/-/${pkg}-${version}.tgz`,
                integrity,
              },
            },
          },
        }),
      )
      return
    }

    if (url.pathname === `/${pkg}/-/${pkg}-${version}.tgz`) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(tarball.length),
      })
      res.end(tarball)
      return
    }

    res.writeHead(404)
    res.end("not found")
  })

  return { hits, server }
}

function startProxy() {
  const hits: string[] = []
  const server = http.createServer(async (req, res) => {
    const target = req.url?.startsWith("http://") ? new URL(req.url) : undefined
    hits.push(req.url || "")

    if (!target) {
      res.writeHead(502)
      res.end("expected absolute proxy URL")
      return
    }

    try {
      const upstream = await fetch(target, {
        headers: Object.entries(req.headers).reduce((acc, [key, value]) => {
          if (key === "connection" || key === "host" || key === "proxy-connection") return acc
          if (typeof value === "string") acc.push([key, value])
          if (Array.isArray(value)) acc.push([key, value.join(", ")])
          return acc
        }, [] as [string, string][]),
        method: req.method,
      })

      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (error) {
      res.writeHead(502)
      res.end(error instanceof Error ? error.message : String(error))
    }
  })

  return { hits, server }
}

function npmLayer(root: string) {
  const global = Layer.succeed(Global.Service, {
    home: root,
    data: path.join(root, ".data", "opencode"),
    cache: path.join(root, ".cache", "opencode"),
    config: path.join(root, ".config", "opencode"),
    state: path.join(root, ".state", "opencode"),
    bin: path.join(root, ".cache", "opencode", "bin"),
    log: path.join(root, ".data", "opencode", "log"),
  })

  const flock = EffectFlock.layer.pipe(Layer.provide(global), Layer.provide(AppFileSystem.defaultLayer))

  return Npm.layer.pipe(
    Layer.provide(global),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(flock),
    Layer.provide(NpmConfig.defaultLayer),
  )
}

describe("Npm proxy", () => {
  test.skipIf(process.platform === "win32")("installs through proxy from npm config", async () => {
    await using tmp = await tmpdir()
    const tarball = await createTarball(tmp.path)
    const registry = startRegistry(tarball)
    const proxy = startProxy()

    try {
      const registryPort = await listen(registry.server)
      const proxyPort = await listen(proxy.server)
      const userconfig = path.join(tmp.path, "user.npmrc")
      await Bun.write(userconfig, `registry=http://127.0.0.1:${registryPort}/\nproxy=http://127.0.0.1:${proxyPort}\n`)

      const restore = env({
        http_proxy: undefined,
        HTTP_PROXY: undefined,
        https_proxy: undefined,
        HTTPS_PROXY: undefined,
        no_proxy: undefined,
        NO_PROXY: undefined,
        npm_config_globalconfig: path.join(tmp.path, "global.npmrc"),
        npm_config_registry: undefined,
        npm_config_proxy: undefined,
        npm_config_userconfig: userconfig,
      })

      try {
        const exit = await Effect.gen(function* () {
          const npm = yield* Npm.Service
          return yield* npm.add(pkg)
        }).pipe(Effect.provide(npmLayer(tmp.path)), Effect.timeout(10000), Effect.runPromiseExit)

        if (exit._tag !== "Success") {
          throw new Error(
            JSON.stringify({
              proxy: proxy.hits,
              registry: registry.hits,
              exit,
            }),
          )
        }

        const result = exit.value

        expect(proxy.hits.some((hit) => hit.includes(`127.0.0.1:${registryPort}/${pkg}`))).toBe(true)
        expect(registry.hits).toContain(`/${pkg}`)
        expect(registry.hits).toContain(`/${pkg}/-/${pkg}-${version}.tgz`)
        expect(result.directory).toContain(`${pkg}`)
      } finally {
        restore()
      }
    } finally {
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()))
      await new Promise<void>((resolve) => registry.server.close(() => resolve()))
    }
  })
})

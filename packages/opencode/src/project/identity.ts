import { existsSync, readFileSync, statSync, writeFileSync } from "fs"
import path from "path"
import { ProjectID } from "./schema"

export namespace ProjectIdentity {
  export type Info = {
    id: ProjectID
    root: string
    sandbox: string
    vcs?: "git"
  }

  export function norm(input: string) {
    const next = path.resolve(input).replace(/\\/g, "/")
    const trim = /^\/+$/g.test(next) ? "/" : next.replace(/\/+$/, "")
    return trim.toLowerCase()
  }

  function marker(dir: string): string | undefined {
    let cur = path.resolve(dir)
    while (true) {
      const git = path.join(cur, ".git")
      if (existsSync(git)) return git
      const parent = path.dirname(cur)
      if (parent === cur) return
      cur = parent
    }
  }

  function commonDir(gitPath: string): string | undefined {
    try {
      if (!statSync(gitPath).isFile()) return
      const match = /^gitdir:\s*(.+)\s*$/im.exec(readFileSync(gitPath, "utf-8"))
      if (!match) return
      const dir = path.resolve(path.dirname(gitPath), match[1])
      const idx = dir.replace(/\\/g, "/").lastIndexOf("/worktrees/")
      if (idx < 0) return
      return dir.slice(0, idx)
    } catch {
      return
    }
  }

  function readCachedId(dir: string): ProjectID | undefined {
    const filePath = path.join(dir, "opencode")
    try {
      if (!existsSync(filePath)) return
      const cached = readFileSync(filePath, "utf-8").trim()
      if (cached) return ProjectID.make(cached)
    } catch {}
  }

  function computeFromGit(cwd: string): ProjectID | undefined {
    try {
      const proc = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      if (proc.exitCode !== 0 || !proc.stdout) return
      const roots = proc.stdout
        .toString()
        .split("\n")
        .filter(Boolean)
        .map((x) => x.trim())
        .toSorted()
      const id = roots[0]
      if (!id) return
      return ProjectID.make(id)
    } catch {
      return
    }
  }

  export function resolve(dir: string): Info {
    const git = marker(dir)
    if (!git) {
      const root = path.resolve(dir)
      return {
        id: ProjectID.fromDirectory(norm(root)),
        root,
        sandbox: root,
      }
    }

    const sandbox = path.dirname(git)
    const root = (() => {
      try {
        if (statSync(git).isDirectory()) return sandbox
      } catch {
        return sandbox
      }
      const base = commonDir(git)
      if (!base) return sandbox
      return path.dirname(base)
    })()

    const gitDir = statSync(git).isDirectory()
      ? git
      : (() => {
          const base = commonDir(git)
          return base ? path.join(path.dirname(base), ".git") : git
        })()

    let id = readCachedId(gitDir)
    if (!id && gitDir !== git) {
      id = readCachedId(path.join(path.dirname(git), "opencode"))
    }
    if (!id) {
      id = computeFromGit(sandbox)
      if (id) {
        try {
          writeFileSync(path.join(gitDir, "opencode"), id)
        } catch {}
      }
    }

    if (!id) {
      id = ProjectID.fromDirectory(norm(root))
    }

    return {
      id,
      root,
      sandbox,
      vcs: "git",
    }
  }
}

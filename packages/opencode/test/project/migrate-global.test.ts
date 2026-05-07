import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Database, eq } from "../../src/storage/db"
import { GlobalProjectMapTable } from "../../src/project/global-project-map.sql"
import { ProjectID } from "../../src/project/schema"
import { Log } from "../../src/util/log"
import { $ } from "bun"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("non-git directory project ID", () => {
  test("generates stable hash-based ID for non-git directory", async () => {
    await using tmp = await tmpdir()
    const { project: first } = await Project.fromDirectory(tmp.path)
    expect(first.id).not.toBe(ProjectID.global)
    expect(first.id.length).toBe(16)

    const { project: second } = await Project.fromDirectory(tmp.path)
    expect(second.id).toBe(first.id)
  })

  test("creates global_project_map entry for non-git directory", async () => {
    await using tmp = await tmpdir()
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)

    const dirNorm = tmp.path.replace(/\\/g, "/").toLowerCase()
    const row = Database.use((db) =>
      db.select().from(GlobalProjectMapTable).where(eq(GlobalProjectMapTable.directory, dirNorm)).get(),
    )
    expect(row).toBeDefined()
    expect(row!.project_id).toBe(project.id)
  })

  test("git project ID differs from non-git hash ID", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)
    expect(project.id).not.toBe(ProjectID.global)
    expect(project.id.length).toBe(40)
    expect(project.vcs).toBe("git")
  })

  test("different directories get different hash IDs", async () => {
    await using tmp1 = await tmpdir()
    await using tmp2 = await tmpdir()
    const { project: p1 } = await Project.fromDirectory(tmp1.path)
    const { project: p2 } = await Project.fromDirectory(tmp2.path)
    expect(p1.id).not.toBe(p2.id)
  })
})

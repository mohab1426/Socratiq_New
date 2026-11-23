// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  runtime: { enabled: true, languages: [{ id: "python", label: "Python 3.12", aliases: ["py", "python", "python3"] }], limits: { timeoutMs: 5000, memoryMb: 256, outputBytes: 65536 } },
  calls: [] as { path: string; method?: string; body?: unknown }[],
  pending: null as null | ((v: unknown) => void),
  reply: null as unknown as (body: { run_id: string }) => unknown,
  defaultReply: (body: { run_id: string }) => ({ runId: body.run_id, language: "python", status: "completed", exitCode: 0, signal: null, stdout: "42\n", stderr: "", stdoutTruncated: false, stderrTruncated: false, durationMs: 31, limits: { timeoutMs: 5000, memoryMb: 256, outputBytes: 65536 } }) as unknown,
  hold: false,
}))

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    status: number
    code?: string
    constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code }
  }
  return {
    ApiError,
    api: vi.fn(async (path: string, opts: { method?: string; body?: { run_id: string } } = {}) => {
      h.calls.push({ path, method: opts.method, body: opts.body })
      if (path === "/student/code/runtime") return structuredClone(h.runtime)
      if (opts.method === "DELETE") { h.pending?.({ ...(h.reply(h.calls.find((c) => c.method === "POST")!.body as { run_id: string }) as object), status: "cancelled", stdout: "" }); return undefined }
      if (h.hold) return new Promise((resolve) => { h.pending = resolve })
      return h.reply(opts.body!)
    }),
  }
})

import { codeBlockStore, resetCodeRuntimeCache } from "@/lib/codeRunner"
import { RunnableCodeBlock } from "./RunnableCodeBlock"

beforeEach(() => {
  h.reply = h.defaultReply
  h.calls = []
  h.hold = false
  h.pending = null
  h.runtime.enabled = true
  resetCodeRuntimeCache()
  codeBlockStore.clear()
})
afterEach(cleanup)

const posts = () => h.calls.filter((c) => c.method === "POST")

describe("RunnableCodeBlock", () => {
  it("runs supported code and shows stdout, status and Run again", async () => {
    render(<RunnableCodeBlock code={"print(6 * 7)"} lang="py" blockKey="m1:0" />)
    const run = await screen.findByRole("button", { name: "Run code" })
    await act(async () => { fireEvent.click(run) })
    expect((await screen.findByLabelText("Program output")).textContent).toBe("42\n")
    expect(screen.getByRole("status").textContent).toContain("Completed")
    expect(posts()).toHaveLength(1)
    expect(posts()[0].body).toMatchObject({ language: "python", source: "print(6 * 7)", stdin: "" })
    expect(Object.keys(posts()[0].body as object).sort()).toEqual(["language", "run_id", "source", "stdin"])     // no limits from the browser
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy()
  })

  it("prevents accidental duplicate runs while one is in flight, and Stop cancels it", async () => {
    h.hold = true
    render(<RunnableCodeBlock code={"import time\ntime.sleep(9)"} lang="python" blockKey="m1:1" />)
    const run = await screen.findByRole("button", { name: "Run code" })
    fireEvent.click(run)
    fireEvent.click(run)                                        // second click on the same element: ignored
    await screen.findByRole("button", { name: "Stop running" })
    expect(screen.queryByRole("button", { name: /^run/i })).toBeNull()
    expect(posts()).toHaveLength(1)
    expect(screen.getByText("Running…")).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop running" })) })
    expect(h.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/student/code/executions/run_"))).toBe(true)
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Stopped"))
  })

  it("edits a copy: the original reply is preserved and Reset restores it", async () => {
    render(<RunnableCodeBlock code={"x = 1"} lang="py" blockKey="m1:2" />)
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }))
    const editor = screen.getByLabelText("Code editor") as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: "x = 2\nprint(x)" } })
    expect(screen.getByText(/edited/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Run code" })) })
    expect(posts()[0].body).toMatchObject({ source: "x = 2\nprint(x)" })
    fireEvent.click(screen.getByRole("button", { name: "Reset to the original code" }))
    expect((screen.getByLabelText("Code editor") as HTMLTextAreaElement).value).toBe("x = 1")
  })

  it("Tab indents inside the editor and Ctrl+Enter runs", async () => {
    render(<RunnableCodeBlock code={"if x:"} lang="py" blockKey="m1:3" />)
    fireEvent.click(await screen.findByRole("button", { name: /edit/i }))
    const editor = screen.getByLabelText("Code editor") as HTMLTextAreaElement
    editor.setSelectionRange(5, 5)
    fireEvent.keyDown(editor, { key: "Tab" })
    expect(editor.value).toBe("if x:    ")
    await act(async () => { fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true }) })
    expect(posts()).toHaveLength(1)
  })

  it("Clear output removes the result", async () => {
    render(<RunnableCodeBlock code={"print(1)"} lang="py" blockKey="m1:4" />)
    const run = await screen.findByRole("button", { name: "Run code" })
    await act(async () => { fireEvent.click(run) })
    await screen.findByLabelText("Program output")
    fireEvent.click(screen.getByRole("button", { name: "Clear output" }))
    expect(screen.queryByLabelText("Program output")).toBeNull()
    expect(screen.getByRole("button", { name: "Run code" })).toBeTruthy()
  })

  it("shows stderr and the exit code for a failing program", async () => {
    h.reply = (b) => ({ runId: b.run_id, language: "python", status: "failed", exitCode: 1, signal: null, stdout: "", stderr: "ZeroDivisionError: division by zero\n", stdoutTruncated: false, stderrTruncated: false, durationMs: 20, limits: h.runtime.limits })
    render(<RunnableCodeBlock code={"1/0"} lang="py" blockKey="m1:5" />)
    const run = await screen.findByRole("button", { name: "Run code" })
    await act(async () => { fireEvent.click(run) })
    const out = await screen.findByLabelText("Program output")
    expect(out.querySelector("[data-stream=stderr]")?.textContent).toContain("ZeroDivisionError")
    expect(screen.getByRole("status").textContent).toContain("exit code 1")
  })

  it("never offers Run for unsupported languages, untagged blocks, or when the runner is off", async () => {
    const { unmount } = render(<><RunnableCodeBlock code={"echo hi"} lang="bash" blockKey="u:0" /><RunnableCodeBlock code={"x"} lang="" blockKey="u:1" /></>)
    await waitFor(() => expect(h.calls.some((c) => c.path === "/student/code/runtime")).toBe(true))
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull()
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(2)
    unmount()
    h.runtime.enabled = false
    resetCodeRuntimeCache()
    render(<RunnableCodeBlock code={"print(1)"} lang="py" blockKey="u:2" />)
    await waitFor(() => expect(h.calls.filter((c) => c.path === "/student/code/runtime")).toHaveLength(2))
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull()
  })

  it("offers Run for a fence tag with extra info and for an untagged fence holding unmistakable Python", async () => {
    render(<><RunnableCodeBlock code={"print(6 * 7)"} lang="python title=demo.py" blockKey="t:0" /><RunnableCodeBlock code={"for i in range(3):\n    print(i)"} lang="" blockKey="t:1" /></>)
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Run code" })).toHaveLength(2))
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Run code" })[1]) })
    expect(posts()[0].body).toMatchObject({ language: "python", source: "for i in range(3):\n    print(i)" })
  })

  it("untagged code that is not clearly Python (JavaScript, shell) stays copy-only", async () => {
    render(<><RunnableCodeBlock code={"const x = 1;\nconsole.log(x)"} lang="" blockKey="t:2" /><RunnableCodeBlock code={"console.log(1)"} lang="javascript" blockKey="t:3" /></>)
    await waitFor(() => expect(h.calls.some((c) => c.path === "/student/code/runtime")).toBe(true))
    expect(screen.queryByRole("button", { name: /run/i })).toBeNull()
    expect(screen.getAllByRole("button", { name: "Copy code" })).toHaveLength(2)
  })

  it("a runner that was off when the chat opened gives the blocks on screen their Run button once it is up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      h.runtime.enabled = false
      render(<RunnableCodeBlock code={"print(1)"} lang="py" blockKey="t:4" />)
      await waitFor(() => expect(h.calls.filter((c) => c.path === "/student/code/runtime")).toHaveLength(1))
      expect(screen.queryByRole("button", { name: "Run code" })).toBeNull()
      h.runtime.enabled = true
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000)
        await vi.runAllTimersAsync()
      })
      expect(screen.getByRole("button", { name: "Run code" })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps the result with its block across a remount (switching views)", async () => {
    const { unmount } = render(<RunnableCodeBlock code={"print(6 * 7)"} lang="py" blockKey="m9:0" />)
    const run = await screen.findByRole("button", { name: "Run code" })
    await act(async () => { fireEvent.click(run) })
    await screen.findByLabelText("Program output")
    unmount()
    render(<RunnableCodeBlock code={"print(6 * 7)"} lang="py" blockKey="m9:0" />)
    expect(screen.getByLabelText("Program output").textContent).toBe("42\n")
  })
})

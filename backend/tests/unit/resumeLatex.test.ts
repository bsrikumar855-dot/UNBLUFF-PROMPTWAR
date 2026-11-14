import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DockerRunner, RunResult } from "../../src/code/docker.js";
import {
  DockerLatexCompiler,
  LocalLatexCompiler,
  type LocalRunner,
  findLocalEngine,
  MAX_LATEX_BYTES,
  summariseLog,
  UnavailableLatex,
  LatexUnavailableError,
} from "../../src/resume/latex.js";

const base = process.env.CODE_WORK_DIR ?? undefined;
const ran = (o: Partial<RunResult> = {}): RunResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ms: 300,
  ...o,
});

/** A fake docker: finds the mounted work folder in the arguments and writes what TeX would have produced. */
function fake(opts: { pdf?: string; log?: string; result?: Partial<RunResult> }) {
  const seen: string[][] = [];
  const runner: DockerRunner = async (args) => {
    seen.push(args);
    const dir = args[args.indexOf("-v") + 1]!.replace(/:\/work:rw$/, ""); // not split(":"): a Windows path contains a drive-letter colon
    await mkdir(dir, { recursive: true });
    if (opts.pdf !== undefined) await writeFile(join(dir, "main.pdf"), opts.pdf);
    if (opts.log !== undefined) await writeFile(join(dir, "main.log"), opts.log);
    return ran(opts.result);
  };
  return { runner, seen, compiler: new DockerLatexCompiler({ runner, workDir: base }) };
}

describe("DockerLatexCompiler", () => {
  it("returns the PDF and page count, and runs TeX in a locked-down container", async () => {
    const f = fake({
      pdf: "%PDF-1.5 fake",
      log: "Output written on main.pdf (2 pages, 1234 bytes).",
    });
    const r = await f.compiler.compile("\\documentclass{article}\\begin{document}x\\end{document}");
    expect(r).toMatchObject({ ok: true, pages: 2, log: "" });
    expect(r.pdf!.toString()).toBe("%PDF-1.5 fake");
    const a = f.seen[0]!.join(" ");
    for (const flag of [
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--pids-limit 96",
      "--init",
      "-no-shell-escape",
      "openin_any=p",
      "openout_any=p",
      "timeout -s KILL 25",
    ])
      expect(a).toContain(flag);
  });

  it("reports TeX errors with their location and produces no PDF", async () => {
    const f = fake({
      log: "./main.tex:3: Undefined control sequence.\nl.3 \\bad\n\nnext",
      result: { code: 1 },
    });
    const r = await f.compiler.compile("\\bad");
    expect(r.ok).toBe(false);
    expect(r.pdf).toBeNull();
    expect(r.log).toContain("main.tex:3: Undefined control sequence.");
  });

  it("explains a timeout, a missing image and an oversized source, and never throws for those", async () => {
    expect(
      (await fake({ result: { timedOut: true, code: null } }).compiler.compile("x")).log,
    ).toMatch(/longer than 25 seconds/);
    expect((await fake({ result: { code: 137, ms: 26_000 } }).compiler.compile("x")).log).toMatch(
      /longer than 25 seconds/,
    );
    expect((await fake({ result: { code: 125 } }).compiler.compile("x")).log).toMatch(
      /could not be started/,
    );
    const big = await fake({ pdf: "x" }).compiler.compile("a".repeat(MAX_LATEX_BYTES + 1));
    expect(big).toMatchObject({ ok: false });
    expect(big.log).toMatch(/larger than/);
  });

  it("rejects a PDF over 5 MB", async () => {
    const r = await fake({
      pdf: "x".repeat(5 * 1024 * 1024 + 1),
      log: "Output written on main.pdf (1 page, 9 bytes).",
    }).compiler.compile("x");
    expect(r).toMatchObject({ ok: false, pdf: null, pages: 1 });
  });
});

describe("summariseLog and the unavailable compiler", () => {
  it("keeps error lines in both TeX formats and reads the page count", () => {
    const log =
      "This is pdfTeX\n! Undefined control sequence.\nl.1 \\x\n\nwarning noise\n./main.tex:9: Missing $ inserted.\nl.9 a_b\nOutput written on main.pdf (1 page, 10 bytes).";
    const s = summariseLog(log);
    expect(s.pages).toBe(1);
    expect(s.errors).toContain("! Undefined control sequence.");
    expect(s.errors).toContain("./main.tex:9: Missing $ inserted.");
    expect(s.errors).not.toContain("warning noise");
    expect(summariseLog("nothing").pages).toBeNull();
  });

  it("an unconfigured compiler fails with a distinct error", async () => {
    const u = new UnavailableLatex();
    expect(u.configured).toBe(false);
    await expect(u.compile()).rejects.toBeInstanceOf(LatexUnavailableError);
  });
});

/** A fake local engine: writes what TeX would have produced into its working folder and records how it was started. */
function fakeLocal(opts: {
  pdf?: string;
  log?: string;
  result?: Partial<RunResult>;
  engine?: string;
}) {
  const seen: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const runner: LocalRunner = async (command, args, { cwd, env }) => {
    seen.push({ command, args, env, cwd });
    if (opts.pdf !== undefined) await writeFile(join(cwd, "main.pdf"), opts.pdf);
    if (opts.log !== undefined) await writeFile(join(cwd, "main.log"), opts.log);
    return ran(opts.result);
  };
  return {
    seen,
    compiler: new LocalLatexCompiler({
      runner,
      engine: opts.engine ?? "C:/tex/pdflatex.exe",
      workDir: base,
    }),
  };
}

describe("LocalLatexCompiler", () => {
  it("returns the PDF and page count with shell escape off, and passes no secrets to TeX", async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "not-a-real-key-for-test";
    try {
      const f = fakeLocal({
        pdf: "%PDF-1.5 fake",
        log: "Output written on main.pdf (1 page, 99 bytes).",
      });
      const r = await f.compiler.compile(
        "\\documentclass{article}\\begin{document}x\\end{document}",
      );
      expect(r).toMatchObject({ ok: true, pages: 1, log: "" });
      expect(r.pdf!.toString()).toBe("%PDF-1.5 fake");
      const call = f.seen[0]!;
      for (const flag of ["-no-shell-escape", "-halt-on-error", "-interaction=nonstopmode"])
        expect(call.args).toContain(flag);
      expect(call.args).not.toContain("-undump=pdflatex"); // a real pdflatex needs no format flag
      expect(call.env).not.toHaveProperty("GEMINI_API_KEY");
      expect(call.env.openout_any).toBe("p");
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  });

  it("starts MiKTeX's engine with the pdflatex format and the package installer disabled", async () => {
    const f = fakeLocal({ engine: "C:/MiKTeX/bin/x64/miktex-pdftex.exe", pdf: "x", log: "" });
    await f.compiler.compile("x");
    expect(f.seen[0]!.args).toEqual(
      expect.arrayContaining(["-undump=pdflatex", "-disable-installer", "-no-shell-escape"]),
    );
  });

  it("reports TeX errors, a timeout, a missing engine and an oversized source without throwing", async () => {
    const bad = await fakeLocal({
      log: "./main.tex:3: Undefined control sequence.\nl.3 \\bad\n\nnext",
      result: { code: 1 },
    }).compiler.compile("\\bad");
    expect(bad).toMatchObject({ ok: false, pdf: null });
    expect(bad.log).toContain("main.tex:3: Undefined control sequence.");
    expect(
      (await fakeLocal({ result: { timedOut: true, code: null } }).compiler.compile("x")).log,
    ).toMatch(/longer than 25 seconds/);
    expect((await fakeLocal({ result: { code: 127 } }).compiler.compile("x")).log).toMatch(
      /could not be started/,
    );
    const big = await fakeLocal({ pdf: "x" }).compiler.compile("a".repeat(MAX_LATEX_BYTES + 1));
    expect(big.log).toMatch(/larger than/);
  });

  it("says so when no engine can be found", async () => {
    const saved = { p: process.env.PATH, e: process.env.LATEX_ENGINE, l: process.env.LOCALAPPDATA };
    process.env.PATH = "";
    process.env.LATEX_ENGINE = join(tmpdir(), "definitely-not-a-tex-engine.exe");
    delete process.env.LOCALAPPDATA;
    try {
      const r = await new LocalLatexCompiler({ workDir: base }).compile("x");
      expect(r).toMatchObject({ ok: false, pdf: null });
      expect(r.log).toMatch(/No local LaTeX engine was found/);
    } finally {
      process.env.PATH = saved.p;
      if (saved.e === undefined) delete process.env.LATEX_ENGINE;
      else process.env.LATEX_ENGINE = saved.e;
      if (saved.l !== undefined) process.env.LOCALAPPDATA = saved.l;
    }
  });
});

describe("findLocalEngine", () => {
  it("uses LATEX_ENGINE when it exists, and null when it points nowhere", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unbluff-eng-"));
    try {
      const exe = join(dir, "pdflatex");
      await writeFile(exe, "");
      expect(findLocalEngine({ LATEX_ENGINE: exe, PATH: "" })).toBe(exe);
      expect(findLocalEngine({ LATEX_ENGINE: join(dir, "nope"), PATH: dir })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

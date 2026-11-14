import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnDocker, type DockerRunner, type RunResult } from "../code/docker.js";

/**
 * The built-in LaTeX compiler. Compilation runs TeX on student-written source, which is untrusted input, so it never
 * runs in the API process: each compile gets a throwaway Docker container with no network, a read-only root, a
 * memory and process cap, shell escape off, and TeX's "paranoid" file mode (it cannot read or write outside the
 * work folder). Like the local code runner this is for DEVELOPMENT; config.ts refuses it in production. Build the
 * image with `docker build -t unbluff-latex:1 backend/scripts/latex`. Where Docker is not available,
 * LATEX_COMPILER=local uses TeX installed on the machine instead (LocalLatexCompiler, below): weaker isolation, same
 * development-only rule.
 */

export const MAX_LATEX_BYTES = 60_000; // a résumé is a few KB; the cap leaves room under the 100 kb JSON body limit after escaping
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const LIMIT_SECONDS = 25;

export interface CompileResult {
  ok: boolean;
  /** The PDF, or null when compilation failed. */
  pdf: Buffer | null;
  /** The compiler's own error messages, trimmed. Empty on success. */
  log: string;
  pages: number | null;
  duration_ms: number;
}

export interface LatexCompiler {
  readonly name: string;
  readonly configured: boolean;
  compile(latex: string): Promise<CompileResult>;
}

/** No compiler is set up on this server. */
export class LatexUnavailableError extends Error {
  constructor() {
    super("No LaTeX compiler is configured on this server.");
    this.name = "LatexUnavailableError";
  }
}

export class UnavailableLatex implements LatexCompiler {
  readonly name = "none";
  readonly configured = false;
  async compile(): Promise<CompileResult> {
    throw new LatexUnavailableError();
  }
}

/** Pulls the useful part out of a TeX log: the "!" error lines with a little context, and the page count. */
export function summariseLog(log: string): { errors: string; pages: number | null } {
  const pages = /Output written on [^\n(]*\((\d+) pages?/.exec(log);
  const lines = log.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // "! Error" (classic) or "main.tex:12: Error" (-file-line-error): the message plus a little context.
    if (lines[i]!.startsWith("!") || /^(?:\.\/)?[\w./-]+\.tex:\d+: /.test(lines[i]!))
      out.push(...lines.slice(i, i + 3).map((l) => l.trimEnd()), "");
    else if (/^(LaTeX|Package) .*(Warning|Error)/.test(lines[i]!) && /Error/.test(lines[i]!))
      out.push(lines[i]!.trimEnd());
  }
  return { errors: out.join("\n").trim().slice(0, 2500), pages: pages ? Number(pages[1]) : null };
}

export class DockerLatexCompiler implements LatexCompiler {
  readonly name = "docker";
  readonly configured = true;

  constructor(
    private readonly opts: { image?: string; runner?: DockerRunner; workDir?: string } = {},
  ) {}

  async compile(latex: string): Promise<CompileResult> {
    const started = Date.now();
    const done = (r: Omit<CompileResult, "duration_ms">): CompileResult => ({
      ...r,
      duration_ms: Date.now() - started,
    });
    if (Buffer.byteLength(latex, "utf8") > MAX_LATEX_BYTES)
      return done({
        ok: false,
        pdf: null,
        log: `The source is larger than ${MAX_LATEX_BYTES / 1000} KB.`,
        pages: null,
      });

    // Snap-packaged Docker cannot see /tmp, so the base directory is configurable (CODE_WORK_DIR), as for the code runner.
    const base = this.opts.workDir ?? process.env.CODE_WORK_DIR ?? tmpdir();
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, "unbluff-tex-"));
    try {
      await chmod(dir, 0o777); // the container user is not the host user
      await writeFile(join(dir, "main.tex"), latex, "utf8");
      const name = `unbluff-tex-${randomBytes(6).toString("hex")}`;
      const args = [
        "run",
        "--rm",
        "-i",
        "--init",
        "--name",
        name,
        "--network",
        "none",
        "--memory",
        "640m",
        "--memory-swap",
        "640m",
        "--cpus",
        "1",
        "--pids-limit",
        "96",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--cap-drop",
        "ALL",
        "-e",
        "openin_any=p",
        "-e",
        "openout_any=p", // TeX paranoid mode: no files outside the work folder
        "-e",
        "TEXMFVAR=/tmp/texmf-var",
        "-e",
        "TEXMFCONFIG=/tmp/texmf-config",
        "-v",
        `${dir}:/work:rw`,
        "-w",
        "/work",
        this.opts.image ?? "unbluff-latex:1",
        "timeout",
        "-s",
        "KILL",
        String(LIMIT_SECONDS),
        "pdflatex",
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "main.tex",
      ];
      const run = await (this.opts.runner ?? spawnDocker)(
        args,
        "",
        (LIMIT_SECONDS + 5) * 1000,
        name,
      );
      return await collect(
        dir,
        run,
        done,
        "The LaTeX compiler could not be started. Is the unbluff-latex image built?",
        [125, 126, 127],
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Turns a finished TeX run (in `dir`) into a CompileResult. Shared by the Docker and local compilers. */
async function collect(
  dir: string,
  run: RunResult,
  done: (r: Omit<CompileResult, "duration_ms">) => CompileResult,
  notStartedMessage: string,
  notStartedCodes: readonly number[],
): Promise<CompileResult> {
  const logText = await readFile(join(dir, "main.log"), "utf8").catch(
    () => run.stderr || run.stdout,
  );
  const { errors, pages } = summariseLog(logText);

  const pdfPath = join(dir, "main.pdf");
  const size = await stat(pdfPath)
    .then((s) => s.size)
    .catch(() => 0);
  if (run.timedOut || (run.code === 137 && run.ms >= LIMIT_SECONDS * 1000))
    return done({
      ok: false,
      pdf: null,
      log: `Compilation took longer than ${LIMIT_SECONDS} seconds and was stopped.`,
      pages: null,
    });
  if (run.code !== null && notStartedCodes.includes(run.code))
    return done({ ok: false, pdf: null, log: notStartedMessage, pages: null });
  if (run.code !== 0 || size === 0)
    return done({
      ok: false,
      pdf: null,
      log: errors || "Compilation failed. No error message was produced.",
      pages: null,
    });
  if (size > MAX_PDF_BYTES)
    return done({ ok: false, pdf: null, log: "The PDF is larger than 5 MB.", pages });
  return done({ ok: true, pdf: await readFile(pdfPath), log: errors, pages });
}

/** Runs a program with a hard time limit. Injectable so tests never need TeX installed. */
export type LocalRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<RunResult>;

const spawnLocal: LocalRunner = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-20_000)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20_000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        code: 127,
        stdout,
        stderr: stderr || err.message,
        timedOut: false,
        ms: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });

/** Environment variables TeX needs to find its files. Everything else (API keys, tokens) is deliberately NOT passed. */
const TEX_ENV_ALLOWLIST = [
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
] as const;

/** The MiKTeX engine has no pdflatex executable of its own: it loads the pdflatex format with -undump. */
const isMiktexEngine = (path: string): boolean => /miktex-pdftex(\.exe)?$/i.test(path);

/**
 * Finds a TeX engine on this machine: `LATEX_ENGINE` if set, else `pdflatex` on PATH, else a per-user MiKTeX install
 * (Windows). Returns null when none is found, so the caller reports the compiler as unavailable instead of failing late.
 */
export function findLocalEngine(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.LATEX_ENGINE?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const exe = process.platform === "win32" ? "pdflatex.exe" : "pdflatex";
  for (const dir of (env.PATH ?? "").split(delimiter))
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  const miktex = env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "Programs", "MiKTeX", "miktex", "bin", "x64", "miktex-pdftex.exe")
    : "";
  return miktex && existsSync(miktex) ? miktex : null;
}

/**
 * Builds PDFs with a TeX install on this machine (LATEX_COMPILER=local), for development where Docker is not
 * available. It is LESS isolated than Docker: TeX runs as the same user as the API, so config.ts refuses it in
 * production. What it does do: shell escape off, the package installer off (a document cannot make MiKTeX download
 * anything), an allowlisted environment with no secrets, a throwaway work folder, a 25 s kill, and the same
 * size limits and result handling as the Docker compiler.
 */
export class LocalLatexCompiler implements LatexCompiler {
  readonly name = "local";
  readonly configured = true;

  constructor(
    private readonly opts: { engine?: string; runner?: LocalRunner; workDir?: string } = {},
  ) {}

  async compile(latex: string): Promise<CompileResult> {
    const started = Date.now();
    const done = (r: Omit<CompileResult, "duration_ms">): CompileResult => ({
      ...r,
      duration_ms: Date.now() - started,
    });
    if (Buffer.byteLength(latex, "utf8") > MAX_LATEX_BYTES)
      return done({
        ok: false,
        pdf: null,
        log: `The source is larger than ${MAX_LATEX_BYTES / 1000} KB.`,
        pages: null,
      });
    const engine = this.opts.engine ?? findLocalEngine();
    if (!engine)
      return done({
        ok: false,
        pdf: null,
        log: "No local LaTeX engine was found. Install MiKTeX or TeX Live, or set LATEX_ENGINE to its pdflatex.",
        pages: null,
      });

    const base = this.opts.workDir ?? process.env.CODE_WORK_DIR ?? tmpdir();
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, "unbluff-tex-"));
    try {
      await writeFile(join(dir, "main.tex"), latex, "utf8");
      const env: NodeJS.ProcessEnv = {};
      for (const k of TEX_ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k];
      env.openin_any = "p"; // TeX Live paranoid mode: nothing outside the work folder
      env.openout_any = "p";
      const args = [
        ...(isMiktexEngine(engine) ? ["-undump=pdflatex", "-disable-installer"] : []),
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        "main.tex",
      ];
      const run = await (this.opts.runner ?? spawnLocal)(engine, args, {
        cwd: dir,
        env,
        timeoutMs: LIMIT_SECONDS * 1000,
      });
      return await collect(
        dir,
        run,
        done,
        "The LaTeX engine could not be started. Check LATEX_ENGINE or that MiKTeX / TeX Live is installed.",
        [127],
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

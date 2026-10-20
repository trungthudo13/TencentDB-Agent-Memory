/**
 * GitSourceFetcher — 基于 simple-git 的源码拉取实现。
 *
 * simple-git 内部用 child_process.spawn + args 数组，不走 shell，从原理上消除 shell 注入。
 *
 * 安全防护（002 §4-5）：
 *   - R1 git hooks：clone/fetch 本就不拉取远端 .git/hooks（hooks 为本地态），故不额外
 *     配置 core.hooksPath（加固版 git 会拒绝该配置，需 allowUnsafeHooksPath）。
 *   - R2 SSRF：允许 HTTPS / SSH + 内网/环回地址黑名单（对齐项目 security_rules）。
 *   - Bug 修复（方案 A）：增量 sync 的 git clean 排除 .codegraph/，避免删掉 codegraph 索引库。
 */

import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { GitCredentials } from "./git-credentials.js";
import simpleGit, { CleanOptions, ResetMode } from "simple-git";
import type { ISourceFetcher, FetchResult, SourceType } from "./types.js";

/**
 * 内网 / 环回 / link-local 地址黑名单（标准网段）：
 *   - 10. / 172.16-31. / 192.168.  → RFC1918 私有网段
 *   - 169.254.                     → link-local（含云元数据 169.254.169.254）
 *   - 127. / 0. / localhost / ::1  → 环回
 *   - fe80:                        → IPv6 link-local
 *
 * 该黑名单可通过环境变量 KNOWLEDGE_SSRF_CHECK=off 关闭（见 GitSourceFetcher 构造）。
 */
const PRIVATE_ADDR_RE =
  /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|127\.|0\.|localhost$|::1$|fe80:)/i;

/**
 * 读取 SSRF 私网黑名单开关。默认开启；
 * 当 KNOWLEDGE_SSRF_CHECK 为 off/false/0/no（大小写不敏感）时关闭。
 */
function ssrfCheckEnabledFromEnv(): boolean {
  const raw = process.env.KNOWLEDGE_SSRF_CHECK;
  if (raw == null || raw.trim() === "") return true;
  const v = raw.trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

export interface GitSourceFetcherOptions {
  knownHostsPath?: string;
  /**
   * 是否启用 SSRF 私网 / 环回地址黑名单校验。
   * 默认读环境变量 KNOWLEDGE_SSRF_CHECK（默认开启）；显式传入时优先于环境变量。
   */
  ssrfCheck?: boolean;
}

// Only application-generated askpass/SSH commands and the empty credential helper are enabled.
const AUTH_GIT_OPTIONS = { unsafe: {
  allowUnsafeAskPass: true, allowUnsafeSshCommand: true,
  allowUnsafeConfigEnvCount: true, allowUnsafeCredentialHelper: true,
} };

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv;
  // Background Git operations never need terminal editors or pagers.
  for (const key of ['PAGER', 'GIT_PAGER', 'EDITOR', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) delete env[key];
  return env;
}

export class GitSourceFetcher implements ISourceFetcher {
  readonly supportedType: SourceType = "git";

  /** SSRF 私网黑名单校验开关（HTTPS / SSH 协议校验始终生效，不受此开关影响）。 */
  private readonly ssrfCheck: boolean;
  private readonly knownHostsPath?: string;

  constructor(opts?: GitSourceFetcherOptions) {
    this.knownHostsPath = opts?.knownHostsPath;
    this.ssrfCheck = opts?.ssrfCheck ?? ssrfCheckEnabledFromEnv();
  }

  validate(sourceUrl: string): void {
    if (/\s|[\x00-\x1f]/.test(sourceUrl)) throw new Error("Invalid repository URL");
    const scp = /^[a-zA-Z0-9._-]+@([a-zA-Z0-9.-]+):([^\s]+)$/.exec(sourceUrl);
    let host = scp?.[1];
    if (!scp) {
      let url: URL;
      try { url = new URL(sourceUrl); } catch { throw new Error("Invalid repository URL"); }
      if (!['https:', 'ssh:'].includes(url.protocol)) throw new Error("Use an HTTPS or SSH repository URL");
      if (url.password || (url.protocol === 'https:' && url.username)) throw new Error("Enter credentials in the authentication fields, not the URL");
      if (url.search || url.hash || url.pathname === '/') throw new Error("Invalid repository URL");
      if (url.protocol === 'ssh:' && url.username && !/^[a-zA-Z0-9._-]+$/.test(url.username)) throw new Error("Invalid SSH username");
      host = url.hostname.replace(/^\[|\]$/g, '');
    }
    if (!host) throw new Error("Invalid repository host");
    // R2: SSRF 防护 —— 禁止指向内网 / 环回地址（可经 KNOWLEDGE_SSRF_CHECK=off 关闭）。
    if (this.ssrfCheck && this.isPrivateAddress(host)) {
      throw new Error(`repo_url must not point to private/loopback address: ${host}`);
    }
  }

  async fetch(sourceUrl: string, branch: string, localPath: string, credentials?: GitCredentials): Promise<FetchResult> {
    this.validate(sourceUrl);
    // 浅克隆单分支。注：git clone/fetch 不会拉取远端的 .git/hooks（hooks 是本地态），
    // 所以正常仓库 clone 出来不带可执行钩子；此处不再配置 core.hooksPath
    // （加固版 git 会拒绝该配置：需 allowUnsafeHooksPath）。
    await this.withAuth(credentials, async (env) => simpleGit(AUTH_GIT_OPTIONS).env(env).clone(sourceUrl, localPath, {
      "--depth": 1,
      "--branch": branch,
    }));
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  async sync(sourceUrl: string, branch: string, localPath: string, credentials?: GitCredentials): Promise<FetchResult> {
    this.validate(sourceUrl);
    const git = simpleGit(localPath, AUTH_GIT_OPTIONS);
    await this.withAuth(credentials, async (env) => git.env(env).fetch("origin", branch, { "--depth": 1 }));
    await git.reset(ResetMode.HARD, [`origin/${branch}`]);
    // Bug 修复（方案 A）：clean 排除 .codegraph/，否则会删掉 codegraph 的索引库，
    // 导致增量 sync 永远失败、每次回退到全量 clone。
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE, ["-e", ".codegraph"]);
    const version = await this.headCommit(localPath);
    return { localPath, version, sourceType: "git" };
  }

  // ── 内部 helper ──

  private async headCommit(localPath: string): Promise<string | null> {
    try {
      return (await simpleGit(localPath, AUTH_GIT_OPTIONS).env(gitEnvironment()).revparse(["HEAD"])).trim().slice(0, 12);
    } catch {
      return null;
    }
  }

  private async withAuth<T>(credentials: GitCredentials | undefined, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const env = gitEnvironment();
    const dir = await mkdtemp(join(tmpdir(), 'codegraph-git-'));
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    try {
      if (this.knownHostsPath) {
        await mkdir(dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
        await writeFile(this.knownHostsPath, '', { flag: 'a', mode: 0o600 });
      }
      const hostOptions = '-o StrictHostKeyChecking=accept-new' + (this.knownHostsPath ? ` -o UserKnownHostsFile=${quote(this.knownHostsPath)}` : '');
      const askpass = join(dir, 'askpass');
      await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n*Username*) printf "%s\\n" "$CG_GIT_USERNAME" ;;\n*) printf "%s\\n" "$CG_GIT_PASSWORD" ;;\nesac\n', { mode: 0o700 });
      Object.assign(env, {
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? `ssh -o BatchMode=yes ${hostOptions}`,
      });
      if (credentials?.username || credentials?.password) {
        Object.assign(env, { GIT_ASKPASS: askpass, CG_GIT_USERNAME: credentials.username ?? '', CG_GIT_PASSWORD: credentials.password ?? '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' });
      }
      if (credentials?.private_key) {
        const keyPath = join(dir, 'identity');
        await writeFile(keyPath, credentials.private_key.trim() + '\n', { mode: 0o600 });
        Object.assign(env, {
          GIT_SSH_COMMAND: `ssh -i ${quote(keyPath)} -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no ${hostOptions} -o BatchMode=${credentials.passphrase ? 'no' : 'yes'}`,
          SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0',
          CG_GIT_PASSWORD: credentials.passphrase ?? '',
        });
      }
      return await run(env);
    } catch (error) {
      // Do not forward remote stderr when credentials were supplied: servers may echo secrets.
      if (credentials) throw new Error('Git clone/fetch failed. Check repository access, credentials, branch and SSH host trust.');
      throw error;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  private isPrivateAddress(host: string): boolean {
    return PRIVATE_ADDR_RE.test(host);
  }
}

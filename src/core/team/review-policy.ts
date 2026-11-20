export type ReviewPolicy = "always" | "risky" | "never";
export const REVIEW_POLICIES: readonly ReviewPolicy[] = [
  "always",
  "risky",
  "never",
];
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = "risky";
export const SMALL_DIFF_LINES = 150;

export function parseReviewPolicy(value: unknown): ReviewPolicy {
  if (typeof value === "string") {
    const policy = value.trim().toLowerCase();
    if (REVIEW_POLICIES.includes(policy as ReviewPolicy)) {
      return policy as ReviewPolicy;
    }
  }
  throw new Error("Review policy must be always, risky or never");
}

export function isSensitivePath(path: string): boolean {
  const segments = path.replace(/\\/g, "/").toLowerCase().split("/");
  const basename = segments.pop() ?? "";
  const dot = basename.lastIndexOf(".");
  const stem = dot < 0 ? basename : basename.slice(0, dot);
  const extension = dot < 0 ? "" : basename.slice(dot + 1);
  const parts = stem.split(/[-_.]/);
  const auth = /^(auth|oauth|login|credentials?|permissions?)$/;
  if (
    segments.some((segment) => auth.test(segment)) ||
    parts.some((part) => auth.test(part))
  )
    return true;
  if (
    segments.some((segment) => /^sessions?$/.test(segment)) ||
    /^sessions?$/.test(stem)
  )
    return true;
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    parts.some((part) => /^secrets?$/.test(part)) ||
    /^(pem|key|p12|pfx|crt)$/.test(extension) ||
    basename.startsWith("id_rsa") ||
    [".npmrc", ".yarnrc.yml", "electron-builder.yml"].includes(basename) ||
    segments.includes("config") ||
    /\.config\.(js|cjs|mjs|ts|json)$/.test(basename) ||
    /^tsconfig.*\.json$/.test(basename)
  )
    return true;
  if (
    basename.startsWith("dockerfile") ||
    /^docker-compose.*\.ya?ml$/.test(basename) ||
    [
      "vercel.json",
      "netlify.toml",
      "fly.toml",
      "render.yaml",
      "procfile",
      "app.yaml",
      "wrangler.toml",
      "serverless.yml",
    ].includes(basename) ||
    extension === "tf" ||
    segments.some((segment) => /^(deploy|k8s|helm|packaging)$/.test(segment)) ||
    parts.includes("deploy")
  )
    return true;
  if (
    segments.some((segment) => /^(migrations?|migrate)$/.test(segment)) ||
    parts.some((part) => /^(migrations?|migrate)$/.test(part)) ||
    extension === "sql"
  )
    return true;
  if (
    [
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lockb",
      "pyproject.toml",
      "pipfile",
      "pipfile.lock",
      "poetry.lock",
      "go.mod",
      "go.sum",
      "cargo.toml",
      "cargo.lock",
      "gemfile",
      "gemfile.lock",
      "composer.json",
      "composer.lock",
    ].includes(basename) ||
    /^requirements.*\.txt$/.test(basename)
  )
    return true;
  return (
    segments.some((segment) =>
      /^(\.github|\.circleci|\.buildkite)$/.test(segment),
    ) ||
    [
      ".gitlab-ci.yml",
      "azure-pipelines.yml",
      "jenkinsfile",
      ".travis.yml",
    ].includes(basename)
  );
}

export function sensitivePaths(paths: readonly string[]): string[] {
  return paths.filter(isSensitivePath);
}

export interface ReviewInput {
  policy: ReviewPolicy;
  checkPassed: boolean | undefined;
  changedLines: number | null;
  paths: readonly string[];
  driftAlert?: boolean;
  blocked?: number;
}

export interface ReviewDecision {
  review: boolean;
  reason: string;
}

export function decideReview(input: ReviewInput): ReviewDecision {
  if (input.policy === "never")
    return { review: false, reason: "policy never" };
  if (input.policy === "always")
    return { review: true, reason: "policy always" };
  let reason: string;
  if (input.checkPassed === undefined) reason = "no check ran";
  else if (!input.checkPassed) reason = "check failed";
  else if (input.changedLines === null) reason = "changed lines unknown";
  else if (input.changedLines >= SMALL_DIFF_LINES)
    reason = `${input.changedLines} changed lines (limit 150)`;
  else {
    const sensitive = sensitivePaths(input.paths);
    if (sensitive.length)
      reason = `touches sensitive paths: ${sensitive.slice(0, 5).join(", ")}`;
    else if (input.driftAlert) reason = "plan-drift alert";
    else if ((input.blocked ?? 0) > 0)
      reason = "secret-looking files were blocked";
    else
      return {
        review: false,
        reason: `policy risky: ${input.changedLines} changed lines, check passed, no sensitive paths`,
      };
  }
  return { review: true, reason };
}

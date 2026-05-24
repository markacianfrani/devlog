import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function slugFromPath(projectPath: string): string {
  const segments = path
    .resolve(projectPath)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.replace(/[^a-zA-Z0-9]/g, "-"))
    .join("-");

  return `-${segments}`;
}

export function normalizeProjectMatcher(value: string): string {
  return value.trim().toLowerCase();
}

export function matchesExcludedProject(
  excludeProjects: string[],
  ...candidates: Array<string | undefined>
): boolean {
  const haystacks = candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(normalizeProjectMatcher);

  return excludeProjects
    .map(normalizeProjectMatcher)
    .filter(Boolean)
    .some((excludedProject) => haystacks.some((candidate) => candidate.includes(excludedProject)));
}

export function archiveConversation(
  sourcePath: string,
  projectName: string,
  archiveBaseDir: string,
  archiveRelPath: string,
) {
  const archivePath = path.join(archiveBaseDir, projectName, archiveRelPath);

  ensureDir(path.dirname(archivePath));

  if (fs.existsSync(archivePath)) {
    const sourceMtime = fs.statSync(sourcePath).mtimeMs;
    const archiveMtime = fs.statSync(archivePath).mtimeMs;
    if (sourceMtime <= archiveMtime) {
      return false;
    }
  }

  fs.copyFileSync(sourcePath, archivePath);
  return true;
}

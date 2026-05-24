import type { CliOptions, ProgressReporter, SourceSummary } from "../progress.ts";

export type { SourceSummary };

export interface ArchiveStats {
  archived: number;
  skipped: number;
  activity: number;
  processed: number;
}

export type ArchiveSourceFn = (options: CliOptions, progress?: ProgressReporter) => SourceSummary;

export function createArchiveStats(): ArchiveStats {
  return { archived: 0, skipped: 0, activity: 0, processed: 0 };
}

export function makeSummary(
  label: string,
  stats: ArchiveStats,
  activityLabel: string,
  warnings: number = 0,
): SourceSummary {
  return {
    label,
    archived: stats.archived,
    skipped: stats.skipped,
    activity: stats.activity,
    activityLabel,
    warnings,
  };
}

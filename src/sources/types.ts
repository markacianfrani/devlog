import type { CliOptions, Logger, ProgressReporter, SourceSummary } from "../progress.ts";

export type { SourceSummary };

export interface ArchiveStats {
  archived: number;
  skipped: number;
  activity: number;
  processed: number;
}

function tickArchiveProgress(progress: ProgressReporter | undefined, stats: ArchiveStats) {
  progress?.tick({ processed: stats.processed, archived: stats.archived, skipped: stats.skipped });
}

export function recordArchived(stats: ArchiveStats, activity: number, progress?: ProgressReporter) {
  stats.archived++;
  stats.activity += activity;
  stats.processed++;
  tickArchiveProgress(progress, stats);
}

export function recordSkipped(stats: ArchiveStats, progress?: ProgressReporter) {
  stats.skipped++;
  stats.processed++;
  tickArchiveProgress(progress, stats);
}

export function logProjectRollup(
  logger: Logger,
  verbose: boolean,
  projectSlug: string,
  archived: number,
  activity: number,
  activityLabel: string,
) {
  if (!verbose) {
    return;
  }

  if (archived > 0) {
    logger.verbose(`  📊 ${projectSlug}: ${archived} new, ${activity} ${activityLabel}\n`);
  } else {
    logger.verbose(`  📊 ${projectSlug}: all up to date\n`);
  }
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

/**
 * Simple in-memory job manager for background tasks
 */

export interface Job {
  id: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed";
  progress?: {
    current: number;
    total: number;
    message: string;
  };
  result?: unknown;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

const jobs = new Map<string, Job>();

// Clean up old jobs after 1 hour
const JOB_TTL_MS = 60 * 60 * 1000;

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupOldJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.completedAt && now - job.completedAt.getTime() > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

export function createJob(type: string): Job {
  cleanupOldJobs();

  const job: Job = {
    id: generateJobId(),
    type,
    status: "pending",
    startedAt: new Date(),
  };

  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<Job>): void {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, updates);
  }
}

export function listJobs(): Job[] {
  cleanupOldJobs();
  return Array.from(jobs.values()).sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime()
  );
}

export function listActiveJobs(): Job[] {
  return listJobs().filter((j) => j.status === "pending" || j.status === "running");
}

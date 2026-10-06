/** Mirrors the server's public contract. Kept deliberately small and explicit. */

export type IsoDate = string
export type TaskStatus = 'not-started' | 'in-progress' | 'complete'
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

export interface ScheduledTask {
  id: string
  name: string
  durationDays: number
  isMilestone: boolean
  status: TaskStatus
  remainingDays: number
  isForecast: boolean
  earlyStart: IsoDate
  earlyFinish: IsoDate
  lateStart: IsoDate
  lateFinish: IsoDate
  totalFloat: number
  freeFloat: number
  isCritical: boolean
}

export interface Schedule {
  projectStart: IsoDate
  dataDate: IsoDate | null
  projectFinish: IsoDate
  durationWorkingDays: number
  tasks: Record<string, ScheduledTask>
  criticalPath: string[]
  deadlineFloat: number | null
}

export interface BaselineTask {
  taskId: string
  name: string
  start: IsoDate
  finish: IsoDate
  durationDays: number
}

export interface Baseline {
  name: string
  capturedAt: IsoDate
  projectStart: IsoDate
  projectFinish: IsoDate
  tasks: Record<string, BaselineTask>
}

export interface ImpactDriver {
  taskId: string
  name: string
  ownSlipDays: number
  totalSlipDays: number
  isCritical: boolean
  status: TaskStatus | null
}

export interface Impact {
  projectMovedDays: number
  currentFinish: IsoDate
  baselineFinish: IsoDate
  headline: string
  cause: string
  drivers: ImpactDriver[]
  summary: string
}

export interface Project {
  id: string
  name: string
  start_date: IsoDate
  deadline: IsoDate | null
  data_date: IsoDate | null
  computed_finish: IsoDate | null
  status: string
}

export interface Dependency {
  id: string
  predecessorId: string
  successorId: string
  type: DependencyType
  lagDays: number
}

export type ConstraintType =
  | 'ASAP'
  | 'START_NO_EARLIER_THAN'
  | 'FINISH_NO_LATER_THAN'
  | 'MUST_START_ON'

/** The editable inputs behind a task, as opposed to its computed dates. */
export interface TaskDetail {
  id: string
  name: string
  durationDays: number
  phaseId: string | null
  constraintType: ConstraintType
  constraintDate: IsoDate | null
  actualStart: IsoDate | null
  actualFinish: IsoDate | null
  percentComplete: number | null
  remainingDays: number | null
  visibility: 'internal' | 'client'
  sortOrder: number
}

export interface MutationResult {
  schedule: Schedule
  impact: Impact | null
  finishMovedDays: number
  taskId?: string
}

export interface HistoryEntry {
  id: string
  action: string
  field: string | null
  impact_days: number
  summary: string | null
  created_at: string
  finish_before: IsoDate | null
  finish_after: IsoDate | null
  actor_name: string | null
  task_name: string | null
}

export interface ProjectSummary {
  headline: string
  paragraphs: string[]
  facts: {
    phase: 'not-started' | 'in-flight' | 'complete'
    health: 'on-track' | 'ahead' | 'behind-baseline' | 'at-risk'
    asOf: IsoDate
    start: IsoDate
    finish: IsoDate
    deadline: IsoDate | null
    deadlineFloat: number | null
    durationWorkingDays: number
    elapsedWorkingDays: number
    tasksTotal: number
    tasksComplete: number
    tasksInProgress: number
    criticalCount: number
    baselineName: string | null
    baselineFinish: IsoDate | null
    varianceDays: number | null
    drivers: ImpactDriver[]
    nextUp: { id: string; name: string; start: IsoDate; isCritical: boolean } | null
    atRisk: Array<{ id: string; name: string; totalFloat: number }>
  }
}

export interface Template {
  id: string
  name: string
  description: string | null
  category: string
  builtIn: boolean
  taskCount: number
  workingDays: number
}

export interface Attachment {
  id: string
  originalName: string
  mimeType: string
  sizeBytes: number
  kind: 'document' | 'photo' | 'proof'
  note: string | null
  createdAt: string
  uploadedBy?: string | null
}

// ── Team ────────────────────────────────────────────────────────────────────

export type Role = 'owner' | 'planner' | 'field' | 'client'

export interface Member {
  id: string
  name: string
  email: string
  role: Role
  is_active: boolean
  created_at: string
}

export interface Invite {
  id: string
  email: string
  name: string | null
  role: Role
  /** The code itself. Shown so an owner can copy it into a text message. */
  token: string
  /** Derived server-side, so moving domains does not strand old invites. */
  url: string
  expires_at: string
  created_at: string
  invited_by: string | null
}

export interface TeamView {
  members: Member[]
  /** The id of the person asking, so the UI can treat their own row differently. */
  you: string
  invites: Invite[]
  /**
   * Whether this server can send mail. The UI uses it to decide between
   * "an invite has been emailed" and "here is the code, send it yourself" —
   * rather than claiming an email went out that never could.
   */
  emailEnabled: boolean
  /** Only owners and planners consume one. Field and client seats are free. */
  seatsUsed: number
}

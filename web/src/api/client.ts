import type {
  Attachment,
  Baseline,
  Category,
  Dependency,
  HistoryEntry,
  Invite,
  Member,
  MutationResult,
  Phase,
  Project,
  ProjectSummary,
  Role,
  Schedule,
  ScheduleProject,
  Step,
  TaskDetail,
  TeamView,
  Template,
} from './types.js'

/**
 * One configurable base URL for the whole app.
 *
 * Stringline lives under `kevinoue.com/stringline/api` today. When it moves to its
 * own domain this is the only thing that changes — which is why nothing else in
 * the app is allowed to build a URL.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? '/stringline/api'

const TOKEN_KEY = 'stringline.token'
const ROLE_KEY = 'stringline.role'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(ROLE_KEY)
}

/**
 * The signed-in user's role, cached from the last sign-in.
 *
 * A hint only, and deliberately optimistic: `null` means "not known yet", and
 * callers should treat that as permissive and let the server refuse. Guessing
 * *restricted* was the wrong default — a session predating this cache showed
 * an owner the field-user interface, with the controls simply missing and
 * nothing explaining why.
 *
 * `api.me()` is the authority. This exists only so the first paint after a
 * reload does not flicker.
 */
export function getCachedRole(): Role | null {
  const stored = localStorage.getItem(ROLE_KEY)
  const roles: Role[] = ['owner', 'planner', 'field', 'client']
  return roles.includes(stored as Role) ? (stored as Role) : null
}
export function setRole(role: string): void {
  localStorage.setItem(ROLE_KEY, role)
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly detail: string[] | undefined

  constructor(status: number, message: string, code?: string, detail?: string[]) {
    super(message)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken()
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const text = await response.text()
  const payload: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const err = payload as { error?: string; code?: string; detail?: string[] } | null
    throw new ApiError(
      response.status,
      err?.error ?? `Request failed (${response.status})`,
      err?.code,
      err?.detail,
    )
  }
  return payload as T
}

export const api = {
  login: (slug: string, email: string, password: string) =>
    request<{ token: string; user: { id: string; name: string; role: string } }>(
      'POST',
      '/auth/login',
      { slug, email, password },
    ),

  signup: (body: {
    companyName: string
    slug: string
    email: string
    password: string
    name: string
  }) => request<{ token: string }>('POST', '/auth/signup', body),

  /** Whether this instance has any accounts yet. Asked before showing a login. */
  setupStatus: () => request<{ needed: boolean }>('GET', '/setup/status'),

  // ── Team ──────────────────────────────────────────────────────────────────

  team: () => request<TeamView>('GET', '/team'),

  invite: (body: { email: string; role: Role; name?: string }) =>
    request<{ invite: Invite; emailed: boolean; emailError?: string }>(
      'POST',
      '/team/invites',
      body,
    ),

  revokeInvite: (id: string) => request<void>('DELETE', `/team/invites/${id}`),

  /** Unauthenticated: what a code is worth before anyone types a password. */
  validateInvite: (code: string) =>
    request<{
      valid: boolean
      email: string
      name: string | null
      role: Role
      companyName: string
      slug: string
    }>('GET', `/team/invites/${encodeURIComponent(code)}/validate`),

  acceptInvite: (code: string, password: string, name: string) =>
    request<{ token: string; role: Role; slug: string }>(
      'POST',
      `/team/invites/${encodeURIComponent(code)}/accept`,
      { password, name },
    ),

  resetTeammate: (id: string) =>
    request<{ temporaryPassword: string; emailed: boolean; message: string }>(
      'POST',
      `/team/members/${id}/reset-password`,
    ),

  updateMember: (id: string, changes: { role?: Role; isActive?: boolean }) =>
    request<{ member: Member }>('PATCH', `/team/members/${id}`, changes),

  // ── Password recovery ─────────────────────────────────────────────────────

  /**
   * Who the token belongs to, and what they may do.
   *
   * The authority on the signed-in role. Cheap, and unlike a cached copy it
   * cannot go stale when an owner changes somebody's role.
   */
  me: () =>
    request<{ id: string; name: string; email: string; role: Role; companyId: string }>(
      'GET',
      '/auth/me',
    ),

  /** Whether self-service reset can work here. It needs email; the UI hides it otherwise. */
  emailStatus: () => request<{ enabled: boolean }>('GET', '/auth/status'),

  forgotPassword: (slug: string, email: string) =>
    request<{ message: string }>('POST', '/auth/forgot-password', { slug, email }),

  validateReset: (token: string) =>
    request<{ valid: boolean }>(
      'GET',
      `/auth/reset-password/validate?token=${encodeURIComponent(token)}`,
    ),

  resetPassword: (token: string, newPassword: string) =>
    request<{ message: string }>('POST', '/auth/reset-password', { token, newPassword }),

  /** Claim a fresh self-hosted instance. The code is printed in the server log. */
  setup: (body: {
    setupToken: string
    companyName: string
    slug: string
    email: string
    password: string
    name: string
  }) => request<{ token: string; slug: string }>('POST', '/setup', body),

  listTemplates: () => request<{ templates: Template[] }>('GET', '/projects/templates'),

  createFromTemplate: (templateId: string, name: string, startDate: string, deadline?: string) =>
    request<{ projectId: string; taskCount: number }>('POST', '/projects/from-template', {
      templateId,
      name,
      startDate,
      deadline,
    }),

  saveAsTemplate: (projectId: string, name: string, description: string, category: string) =>
    request<{ templateId: string }>('POST', `/projects/${projectId}/save-as-template`, {
      name,
      description,
      category,
    }),

  deleteTemplate: (templateId: string) =>
    request<void>('DELETE', `/projects/templates/${templateId}`),

  archiveProject: (projectId: string) => request<void>('DELETE', `/projects/${projectId}`),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string; message: string }>('POST', '/auth/change-password', {
      currentPassword,
      newPassword,
    }),

  listProjects: () => request<{ projects: Project[] }>('GET', '/projects'),

  createProject: (name: string, startDate: string, deadline?: string) =>
    request<{ project: Project }>('POST', '/projects', { name, startDate, deadline }),

  /**
   * Rename a project or set its printed title block.
   *
   * Deliberately not dates: changing a start or deadline reschedules the
   * project, which has to go through the routes that explain and log the move.
   */
  updateProject: (
    projectId: string,
    changes: { name?: string; printTitle?: string; printSubtitle?: string },
  ) => request<{ project: Project }>('PATCH', `/projects/${projectId}`, changes),

  /**
   * Move the whole project, or change its deadline.
   *
   * Separate from `updateProject` because it moves dates: the reply carries
   * the impact banner, like every other change that shifts a schedule.
   */
  reschedule: (projectId: string, changes: { startDate?: string; deadline?: string | null }) =>
    request<MutationResult>('POST', `/projects/${projectId}/reschedule`, changes),

  getSchedule: (projectId: string) =>
    request<{
      schedule: Schedule
      baseline: Baseline | null
      dependencies: Dependency[]
      details: TaskDetail[]
      phases: Phase[]
      categories: Category[]
      steps: Step[]
      project: ScheduleProject
    }>('GET', `/projects/${projectId}/schedule`),

  // ── Steps ─────────────────────────────────────────────────────────────────
  // A step's duration is part of its task's, so these return a MutationResult
  // with the impact banner — adding one really does move the schedule.

  addStep: (projectId: string, taskId: string, name: string, durationDays = 0) =>
    request<MutationResult>('POST', `/projects/${projectId}/tasks/${taskId}/steps`, {
      name,
      durationDays,
    }),

  updateStep: (
    projectId: string,
    taskId: string,
    stepId: string,
    changes: {
      name?: string
      durationDays?: number
      actualStart?: string | null
      actualFinish?: string | null
    },
  ) =>
    request<MutationResult>(
      'PATCH',
      `/projects/${projectId}/tasks/${taskId}/steps/${stepId}`,
      changes,
    ),

  deleteStep: (projectId: string, taskId: string, stepId: string) =>
    request<MutationResult>('DELETE', `/projects/${projectId}/tasks/${taskId}/steps/${stepId}`),

  reorderSteps: (projectId: string, taskId: string, order: string[]) =>
    request<void>('PUT', `/projects/${projectId}/tasks/${taskId}/steps/order`, { order }),

  // ── Categories ────────────────────────────────────────────────────────────
  // Company-scoped, so these are not under /projects. Labelling work does not
  // reschedule it, so none of them return a MutationResult.

  listCategories: () =>
    request<{
      categories: Category[]
      palette: Array<{ key: string; label: string; hex: string; stripe: string }>
      /** What this company calls the dimension — Trade, Department, Crew. */
      label: string
    }>('GET', '/categories'),

  createCategory: (body: { name: string; description?: string; colour?: string }) =>
    request<{ category: Category }>('POST', '/categories', body),

  updateCategory: (
    id: string,
    changes: { name?: string; description?: string; colour?: string; sortOrder?: number },
  ) => request<{ category: Category }>('PATCH', `/categories/${id}`, changes),

  deleteCategory: (id: string) =>
    request<{ untaggedTasks: number }>('DELETE', `/categories/${id}`),

  setCategoryLabel: (label: string) =>
    request<{ label: string }>('PUT', '/categories/label', { label }),

  // ── Phases ────────────────────────────────────────────────────────────────
  // Grouping only — none of these move a date, so none return a MutationResult.

  createPhase: (projectId: string, name: string) =>
    request<{ phase: Phase }>('POST', `/projects/${projectId}/phases`, { name }),

  updatePhase: (projectId: string, phaseId: string, changes: Partial<Pick<Phase, 'name' | 'visibility'>>) =>
    request<{ phase: Phase }>('PATCH', `/projects/${projectId}/phases/${phaseId}`, changes),

  deletePhase: (projectId: string, phaseId: string) =>
    request<{ unassignedTasks: number }>('DELETE', `/projects/${projectId}/phases/${phaseId}`),

  reorderPhases: (projectId: string, order: string[]) =>
    request<{ phases: Phase[] }>('PUT', `/projects/${projectId}/phases/order`, { order }),

  /**
   * Reorder the task list. Display only — no dates move, so no impact banner.
   */
  reorderTasks: (projectId: string, order: string[]) =>
    request<void>('PUT', `/projects/${projectId}/tasks/order`, { order }),

  /** Copy a task with its steps and predecessors. Successors and actuals are not copied. */
  duplicateTask: (projectId: string, taskId: string) =>
    request<MutationResult & { taskId: string }>(
      'POST',
      `/projects/${projectId}/tasks/${taskId}/duplicate`,
    ),

  createTask: (
    projectId: string,
    body: { name: string; durationDays: number; afterTaskId?: string },
  ) =>
    request<MutationResult>('POST', `/projects/${projectId}/tasks`, body),

  updateTask: (projectId: string, taskId: string, body: Record<string, unknown>) =>
    request<MutationResult>('PATCH', `/projects/${projectId}/tasks/${taskId}`, body),

  deleteTask: (projectId: string, taskId: string) =>
    request<MutationResult>('DELETE', `/projects/${projectId}/tasks/${taskId}`),

  createDependency: (
    projectId: string,
    body: { predecessorId: string; successorId: string; type?: string; lagDays?: number },
  ) => request<MutationResult>('POST', `/projects/${projectId}/dependencies`, body),

  deleteDependency: (projectId: string, dependencyId: string) =>
    request<MutationResult>('DELETE', `/projects/${projectId}/dependencies/${dependencyId}`),

  /**
   * What a drag means. The server owns this: turning "the left edge landed on
   * this date" into a constraint, a duration, or an actual needs the project's
   * calendars, which the browser does not have.
   */
  previewMove: (
    projectId: string,
    taskId: string,
    mode: 'move' | 'resize-start' | 'resize-end',
    targetDate: string,
  ) =>
    request<{
      allowed: boolean
      reason?: string
      patch?: Record<string, unknown>
      description?: string
      affected?: string[]
      warnings?: string[]
      earliestStart: string
      currentFinish: string
      hypotheticalFinish?: string
      schedule?: Schedule
    }>('POST', `/projects/${projectId}/tasks/${taskId}/preview-move`, { mode, targetDate }),

  taskFloor: (projectId: string, taskId: string) =>
    request<{ earliestStart: string }>('GET', `/projects/${projectId}/tasks/${taskId}/floor`),

  /** Solve a hypothetical without saving it — used by the editor panel. */
  whatIf: (projectId: string, tasks: Array<{ id: string } & Record<string, unknown>>) =>
    request<{ currentFinish: string; hypotheticalFinish: string; schedule: Schedule }>(
      'POST',
      `/projects/${projectId}/what-if`,
      { tasks },
    ),

  captureBaseline: (projectId: string, name: string) =>
    request<{ baseline: Baseline }>('POST', `/projects/${projectId}/baselines`, { name }),

  listAttachments: (taskId: string) =>
    request<{ attachments: Attachment[]; accepted: string[]; maxBytes: number }>(
      'GET',
      `/tasks/${taskId}/attachments`,
    ),

  /**
   * Uploads bypass `request()` because the body is multipart, not JSON — and
   * setting Content-Type by hand here would strip the boundary the browser
   * generates and the server would get an unparseable body.
   */
  uploadAttachment: async (taskId: string, file: File, kind: string): Promise<Attachment> => {
    const form = new FormData()
    form.append('file', file)
    form.append('kind', kind)
    const response = await fetch(`${API_BASE}/tasks/${taskId}/attachments`, {
      method: 'POST',
      headers: { ...(getToken() ? { Authorization: `Bearer ${getToken()!}` } : {}) },
      body: form,
    })
    const text = await response.text()
    const payload: unknown = text ? JSON.parse(text) : null
    if (!response.ok) {
      const err = payload as { error?: string } | null
      throw new ApiError(response.status, err?.error ?? `Upload failed (${response.status})`)
    }
    return (payload as { attachment: Attachment }).attachment
  },

  deleteAttachment: (attachmentId: string) =>
    request<void>('DELETE', `/attachments/${attachmentId}`),

  attachmentUrl: (attachmentId: string) => `${API_BASE}/attachments/${attachmentId}`,

  summary: (projectId: string) =>
    request<ProjectSummary>('GET', `/projects/${projectId}/summary`),

  history: (projectId: string) =>
    request<{ history: HistoryEntry[] }>('GET', `/projects/${projectId}/history`),
}

/**
 * Where the source lives.
 *
 * AGPL section 13: because Stringline is offered to users over a network, they
 * have to be able to get the source of the running version. That is a licence
 * obligation, not a nicety, so the link is part of the app rather than
 * something to remember to put on a marketing page.
 */
export const SOURCE_URL =
  import.meta.env.VITE_SOURCE_URL ?? 'https://github.com/kevinoue/stringline'

export { API_BASE }

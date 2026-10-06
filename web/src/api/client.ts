import type {
  Attachment,
  Baseline,
  Dependency,
  HistoryEntry,
  MutationResult,
  Project,
  ProjectSummary,
  Schedule,
  TaskDetail,
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

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
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

  getSchedule: (projectId: string) =>
    request<{
      schedule: Schedule
      baseline: Baseline | null
      dependencies: Dependency[]
      details: TaskDetail[]
    }>('GET', `/projects/${projectId}/schedule`),

  createTask: (projectId: string, body: { name: string; durationDays: number }) =>
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

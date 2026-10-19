export type LimitWindow = { key: string; used: number | null; remaining: number | null; minutes: number | null; resetsAt: number | null };
export type Bucket = { id: string; name: string; plan: string | null; windows: LimitWindow[]; credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | number | null } | null };
export type Account = { id: string; label: string; email: string | null; accountId: string; plan: string; isTarget: boolean; limits: Bucket[]; syncedAt: number | null; error: string | null; addedAt: number };
export type Settings = { cliPath: string; desktopPath: string; codexHome: string; pollSeconds: number; autoSync: boolean; lowResource: boolean; cliAutoDetect: boolean; desktopAutoDetect: boolean };
export type Workflow = { id: string; name: string; mode: 'auto' | 'new' | 'existing'; cwd: string; threadId: string | null; prompt: string; accountIds: string[]; bucketId: string; status: string; message: string; accountId: string | null; turnId: string | null; switchCount: number; output: string; updatedAt: number; lastCheckedAt?: number; executor?: string; scope?: string; completedCount?: number; observedTarget?: { name: string; threadId: string; cwd: string; status: string } | null; source?: { name: string; threadId: string; turnId: string; status: string } | null; approval: { requestId: string | number; command: string; cwd: string; canAccept: boolean } | null };
export type WorkflowInput = { name: string; mode: 'auto' | 'new' | 'existing'; cwd: string; prompt: string; threadId: string; bucketId: string; accountIds: string[] };
export type LocalThread = { id: string; name: string; cwd: string };
export type Snapshot = { workflows: Workflow[]; accounts: Account[]; settings: Settings; syncing: boolean; target: { email: string | null; accountId: string } | null; targetError: string | null;
  login: { label: string; url: string; code: string | null } | null; events: { id: string; at: number; message: string; type: string }[]; canRestore: boolean; platform: string };
export type Result<T = unknown> = { ok: boolean; value?: T; error?: string };
export interface DeckAPI {
  snapshot(): Promise<Result<Snapshot>>; importCurrent(): Promise<Result>; importFile(): Promise<Result>;
  startLogin(label: string, method: string): Promise<Result>; cancelLogin(): Promise<Result>; openLogin(): Promise<Result>;
  sync(id?: string): Promise<Result>; switch(id: string, restart: boolean): Promise<Result<{ message: string }>>;
  remove(id: string): Promise<Result>; rename(id: string, label: string): Promise<Result>; restore(): Promise<Result>;
  settings(patch: Partial<Settings>): Promise<Result>; pick(kind: string): Promise<Result<string | null>>;
  redetect(): Promise<Result>;
  workflowThreads(): Promise<Result<LocalThread[]>>; workflowCreate(input: WorkflowInput): Promise<Result>;
  workflowOpen(id: string): Promise<Result>;
  workflowStart(id: string): Promise<Result>; workflowPause(id: string): Promise<Result>; workflowRemove(id: string): Promise<Result>;
  workflowApprove(id: string, requestId: string | number, accept: boolean): Promise<Result>;
  onChanged(callback: () => void): () => void;
}
declare global { interface Window { deck?: DeckAPI } }

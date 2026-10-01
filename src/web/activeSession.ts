import type { WebSession, WebSessionSummary, WebState } from './types.js';

interface MutableValue<T> {
  current: T;
}

export interface SessionDetailRequest {
  id: string;
  epoch: number;
}

/** 从会话详情显式选取摘要字段，避免把消息和瞬态详情写入列表状态。 */
function toSessionSummary(session: WebSession): WebSessionSummary {
  return {
    id: session.id,
    title: session.title,
    workspace: session.workspace,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    busy: session.busy,
    status: session.status,
    startedAt: session.startedAt,
    pendingMemoryCount: session.pendingMemoryCount,
    memoryExtractionStatus: session.memoryExtractionStatus,
  };
}

/** 将详情对应的摘要插入或替换到当前浏览器状态。 */
export function mergeSessionSummary(state: WebState, session: WebSession): WebState {
  const summary = toSessionSummary(session);
  const sessions = state.sessions.some((item) => item.id === summary.id)
    ? state.sessions.map((item) => item.id === summary.id ? summary : item)
    : [...state.sessions, summary];
  return { ...state, sessions };
}

/** 合并新建会话摘要，仅在当前服务端状态尚未包含它时登记保护。 */
export function mergeCreatedSessionSummary(
  state: WebState,
  session: WebSession,
  pendingCreatedIds: Set<string>,
): WebState {
  if (state.sessions.some((item) => item.id === session.id)) {
    pendingCreatedIds.delete(session.id);
  } else {
    pendingCreatedIds.add(session.id);
  }
  return mergeSessionSummary(state, session);
}

/** 合并服务端状态，并仅保留尚未被服务端确认的本地创建摘要。 */
export function mergeServerStateWithPendingSessions(
  serverState: WebState,
  currentState: WebState | null,
  pendingCreatedIds: Set<string>,
): WebState {
  const serverIds = new Set(serverState.sessions.map((session) => session.id));
  for (const id of pendingCreatedIds) {
    if (serverIds.has(id)) pendingCreatedIds.delete(id);
  }
  if (!currentState || pendingCreatedIds.size === 0) return serverState;
  const pendingSessions = currentState.sessions.filter(
    (session) => pendingCreatedIds.has(session.id) && !serverIds.has(session.id),
  );
  return pendingSessions.length === 0
    ? serverState
    : { ...serverState, sessions: [...serverState.sessions, ...pendingSessions] };
}

/** 同步更新当前会话引用和 React 状态，避免渲染前仍读取旧 ID。 */
export function activateSession(
  id: string,
  activeIdRef: MutableValue<string>,
  epochRef: MutableValue<number>,
  setActiveId: (id: string) => void,
): void {
  activeIdRef.current = id;
  epochRef.current++;
  setActiveId(id);
}

/** 仅当删除目标仍是当前会话时，通过统一激活入口清空会话。 */
export function clearActiveSessionIfCurrent(
  id: string,
  activeIdRef: MutableValue<string>,
  epochRef: MutableValue<number>,
  setActiveId: (id: string) => void,
): boolean {
  if (activeIdRef.current !== id) return false;
  activateSession('', activeIdRef, epochRef, setActiveId);
  return true;
}

/** 为详情请求分配单调版本，使后发请求立即淘汰先发请求。 */
export function beginSessionDetailRequest(
  id: string,
  epochRef: MutableValue<number>,
): SessionDetailRequest {
  return { id, epoch: ++epochRef.current };
}

/** 判断详情请求是否仍对应当前会话和最新版本。 */
export function isSessionDetailRequestCurrent(
  request: SessionDetailRequest,
  activeIdRef: MutableValue<string>,
  epochRef: MutableValue<number>,
): boolean {
  return activeIdRef.current === request.id && epochRef.current === request.epoch;
}

/** 仅应用仍为最新版本且响应 ID 匹配的 GET 详情。 */
export function setActiveFromRequest<T extends { id: string }>(
  request: SessionDetailRequest,
  activeIdRef: MutableValue<string>,
  epochRef: MutableValue<number>,
  session: T,
  setActive: (session: T) => void,
): boolean {
  if (!isSessionDetailRequestCurrent(request, activeIdRef, epochRef) ||
    session.id !== request.id) return false;
  epochRef.current++;
  setActive(session);
  return true;
}

/** 应用当前会话的主动更新，并使所有较早详情请求失效。 */
export function setActiveFromUpdate<T extends { id: string }>(
  activeIdRef: MutableValue<string>,
  epochRef: MutableValue<number>,
  session: T,
  setActive: (session: T) => void,
): boolean {
  if (activeIdRef.current !== session.id) return false;
  epochRef.current++;
  setActive(session);
  return true;
}

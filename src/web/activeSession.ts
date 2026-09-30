interface MutableValue<T> {
  current: T;
}

/** 同步更新当前会话引用和 React 状态，避免渲染前仍读取旧 ID。 */
export function activateSession(
  id: string,
  activeIdRef: MutableValue<string>,
  setActiveId: (id: string) => void,
): void {
  activeIdRef.current = id;
  setActiveId(id);
}

/** 仅在请求目标、当前会话和响应会话一致时写入详情。 */
export function setActiveIfCurrent<T extends { id: string }>(
  targetId: string,
  activeIdRef: MutableValue<string>,
  session: T,
  setActive: (session: T) => void,
): boolean {
  if (activeIdRef.current !== targetId || session.id !== targetId) return false;
  setActive(session);
  return true;
}

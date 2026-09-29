import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import wrapAnsi from 'wrap-ansi';
import type { PermissionRequest } from '../tools/types.js';

/** 按终端宽高分页显示完整授权内容，等待时保持静止，便于逐页核对。 */
export function PermissionPrompt({ request }: { request: PermissionRequest }) {
  const { stdout } = useStdout();
  const [dimensions, setDimensions] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => {
    /** 终端尺寸变化时重排当前预览。 */
    function onResize(): void {
      setDimensions({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    }
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  const width = Math.max(10, dimensions.columns - 2);
  const pageSize = Math.max(1, dimensions.rows - 6);
  // 仅展开显示层的 Tab，防止终端二次扩列破坏分页；原始补丁仍由工具原样执行。
  const lines = useMemo(() => wrapAnsi(request.detail.replaceAll('\t', '        '), width, { hard: true, wordWrap: false, trim: false }).split('\n'),
    [request.detail, width]);
  const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  useInput((_value, key) => {
    if (key.rightArrow || key.downArrow || key.pageDown) setPageIndex((page) => Math.min(page + 1, pageCount - 1));
    if (key.leftArrow || key.upArrow || key.pageUp) setPageIndex((page) => Math.max(page - 1, 0));
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="yellow" bold wrap="truncate-end">{request.title}</Text>
      <Text dimColor wrap="truncate-end">第 {currentPage + 1}/{pageCount} 页 · ←/→ 或 PgUp/PgDn 翻页</Text>
      <Box flexDirection="column" height={pageSize}>
        <Text>{lines.slice(currentPage * pageSize, (currentPage + 1) * pageSize).join('\n')}</Text>
      </Box>
      <Text color="yellow" wrap="truncate-end">允许此操作？ [y/N]（回车默认拒绝）</Text>
      <Text dimColor wrap="truncate-end">Ctrl+C 中断 · Tab 显示为 8 空格</Text>
    </Box>
  );
}

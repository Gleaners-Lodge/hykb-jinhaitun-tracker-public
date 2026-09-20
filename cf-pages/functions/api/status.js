/* 归档状态：投票结束后不再访问 GitHub，也不需要 GITHUB_TOKEN。
   保留原路由，让尚未刷新的旧页面与外部访问者收到明确的停止状态。 */
export function onRequestGet() {
  return new Response(JSON.stringify({
    archived: true,
    votingEndedAt: '2026-09-01T00:00:00+08:00',
    collectionStoppedOn: '2026-09-07',
    lastSnapshotAt: null,
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

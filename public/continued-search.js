// 1回の処理上限を超えた分は、店舗ごとに順番に追加確認する。
// 先に見つかった結果はそのまま表示し、失敗しても消さない。
const keyOf = task => `${task.start || ''}|${task.offset || 0}`;
export async function collectStoreResults(fetchPage, previous = null, onProgress = () => {}, maxBatches = 6) {
  let result = previous;
  const queue = previous ? [...(previous.continuations || [])] : [{ start: '', offset: 0 }];
  const seen = new Set(previous?.completedTasks || []);
  let batches = 0;
  while (queue.length && batches++ < maxBatches) {
    const task = queue.shift(), key = keyOf(task);
    if (seen.has(key)) continue;
    try {
      const page = await fetchPage(task);
      if (page.status === 'error' || page.status === 'blocked') {
        if (!result) return { ...page, continuations: [task], completedTasks: [...seen] };
        throw new Error(page.error || '追加確認を取得できませんでした');
      }
      seen.add(key);
      result = mergeStorePage(result, page);
      for (const next of page.continuations || []) if (!seen.has(keyOf(next)) && !queue.some(t=>keyOf(t)===keyOf(next))) queue.push(next);
      // 最後まで循環した場合も完了扱いにはせず、異常の理由を残す。
      if ((page.continuations || []).some(t => keyOf(t) === key)) result.coverage.partialReasons.push('店舗のページ送りが循環しています');
    } catch (error) {
      if (!result) throw error;
      queue.unshift(task);
      result.resumeError = error.message || '追加確認に失敗しました';
      break;
    }
    result.continuations = [...queue];
    result.completedTasks = [...seen];
    onProgress(result);
  }
  if (result) {
    result.continuations = queue;
    result.completedTasks = [...seen];
  }
  return result;
}

export function mergeStorePage(previous, page) {
  if (!previous || (['error','blocked'].includes(previous.status) && !previous.results?.length)) return { ...page, coverage: { ...page.coverage, partialReasons: [...(page.coverage?.partialReasons || [])] }, resumeError: '' };
  const rows = new Map((previous.results || []).map(r=>[r.url,r]));
  for (const url of page.rejectedUrls || []) rows.delete(url);
  for (const row of page.results || []) {
    const old=rows.get(row.url);
    if (!old?.detailChecked || row.detailChecked) rows.set(row.url,row);
  }
  const a=previous.coverage || {}, b=page.coverage || {};
  const results=[...rows.values()];
  return { ...page, manualSearchUrl: previous.manualSearchUrl, results,
    status: results.length ? 'ok' : 'no_hit', resumeError: '',
    coverage: { ...b, pagesRead:(a.pagesRead||0)+(b.pagesRead||0), detailChecks:(a.detailChecks||0)+(b.detailChecks||0),
      noHitConfirmed:Boolean(a.noHitConfirmed && b.noHitConfirmed),
      notes:[...new Set([...(a.notes||[]),...(b.notes||[])])],
      categories:[...(a.categories||[]),...(b.categories||[])],
      partialReasons:[...new Set([...(a.partialReasons||[]),...(b.partialReasons||[])])],
    },
  };
}

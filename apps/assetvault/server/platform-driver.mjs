/** Shared request loop; adapters retain filtering, mapping and source-end rules.
 * ponytail: no pagination DSL or automatic cursor guard; preserve each site's policy.
 * Callers decide whether an initial request is allowed (for-loop vs do/while).
 */
export async function listPager({initialState, maxPages, fetchPage, consume, nextState, isLimitReached, partialOnError = false, onPage}) {
  let state = initialState;
  for (let pages = 0; pages < maxPages; pages++) {
    let response;
    try { response = await fetchPage(state); }
    catch (error) {
      if (!pages || !partialOnError) throw error;
      return {reason: 'partial-error', pages, error};
    }
    consume(response, state);
    onPage?.();
    if (isLimitReached()) return {reason: 'item-limit', pages: pages + 1};
    const next = nextState(response, state);
    if (next === null) return {reason: 'source-end', pages: pages + 1};
    state = next;
  }
  return {reason: 'page-limit', pages: maxPages};
}

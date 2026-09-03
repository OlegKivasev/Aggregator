export const isForumAutoReturnableVisible = (result, showNonReturnable) => (
  result.supplier !== "forum-auto" || showNonReturnable || result.isReturnable !== false
);

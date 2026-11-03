// Recent 分区里草稿（新建但还没落盘的会话）的呈现顺序。
//
// 顺序就是工作区里页签的创建顺序，不跟选中、也不跟最近活动时间变。草稿之间没有
// updatedAt 可排，而「当前那条浮到最前」的规则会让用户每点一次侧栏、这一块就换一次
// 位置——看上去像是自己点错了行。新建的草稿追加在末尾，落盘变成真实会话之后才由
// updatedAt 排进下面的时间桶。
export function orderRecentDrafts(drafts = []) {
  return (Array.isArray(drafts) ? drafts : []).filter((node) => node?.id)
}

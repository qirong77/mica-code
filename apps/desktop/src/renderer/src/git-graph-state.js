/** effect 的请求作用域：卸载后不再启动排队读取，晚到的结果也不能进入新目录。 */
export function createGitGraphRequest(read) {
  let current = true
  return {
    get current() { return current },
    cancel() { current = false },
    promise: Promise.resolve().then(async () => {
      if (!current) return null
      try {
        const response = await read()
        return current ? response : null
      } catch (error) {
        if (current) throw error
        return null
      }
    })
  }
}

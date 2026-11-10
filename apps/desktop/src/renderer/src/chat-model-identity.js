// 会话元数据分别保存 provider 与模型；选择器的 override 已经是完整 id。
// 模型名本身允许包含斜杠，不能根据前缀或后缀猜测供应商。
export function displayedModelId(selectedModel, model, providerId) {
  if (selectedModel) return selectedModel
  if (!model) return ''
  return providerId ? `${providerId}/${model}` : model
}

export function selectedModelEntry(models, selectedModel, model, providerId) {
  const id = displayedModelId(selectedModel, model, providerId)
  return models.find((item) => item.id === id)
}

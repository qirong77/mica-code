/**
 * Placeholder used when the active model does not support image input. The
 * text both explains the omission to the user (it is what gets displayed in
 * transcripts) and instructs the model to state the limitation instead of
 * hallucinating image content.
 */
export function imageOmittedPlaceholder(model: string): string {
  return (
    `[图片已省略] 当前模型 ${model} 不支持图片输入，图片未发送给模型，你无法查看其内容。` +
    `请在回复中如实告知用户：当前模型不支持图片识别，图片已被省略；` +
    `并建议用户切换支持视觉的模型或改用文字描述图片内容。不要猜测或编造图片内容。`
  );
}

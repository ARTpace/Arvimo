/** Localize application status text at display time, including messages already on screen.
 * Only known application messages are translated; filenames and provider responses are preserved.
 */
const messages: Record<string, string> = {
  "Failed to parse 3D model.": "3D 模型解析失败。",
  "Ready to work on this canvas.": "画布已就绪。",
  "Saving project…": "正在保存项目…",
  "Opening workspace…": "正在打开工作区…",
  "Workspace loaded.": "工作区已打开。",
  "No saved workspace was loaded.": "未加载已保存的工作区。",
  "Unable to open the workspace.": "无法打开工作区。",
  "Project saved.": "项目已保存。",
  "Save was cancelled before a project was written.": "已取消保存，项目未写入。",
  "Project save stopped because an import was cancelled.": "导入已取消，项目保存已停止。",
  "Unable to save the project.": "无法保存项目。",
  "Workspace restored.": "工作区已恢复。",
  "Generating...": "正在生成…",
  "Parsing PSD file...": "正在解析 PSD 文件…",
  "Importing assets...": "正在导入资产…",
  "Applying AI perspective shift...": "正在调整图像视角…",
  "Removing background...": "正在移除背景…",
  "Analyzing image...": "正在分析图片…",
  "Starting generation...": "正在开始生成…",
  "Processing video(s)...": "正在处理视频…",
  "An import is already running. Please wait for it to finish.": "正在导入，请等待完成。",
  "Unsupported file format.": "不支持此文件格式。",
  "Failed to start extension import.": "无法启动扩展导入。",
  "Failed to parse PSD file.": "PSD 文件解析失败。",
  "Canvas is not ready for importing files.": "画布尚未就绪，暂时无法导入。",
  "The project or destination board changed while importing.": "导入期间项目或目标画板发生变化。",
  "Not enough memory for the next image.": "内存不足，无法继续导入图片。",
  "Unknown import error.": "导入发生未知错误。",
  "Unsupported image file format.": "不支持此图片格式。",
  "Failed to load background image.": "背景图片加载失败。",
  "AI operation failed to produce an image.": "AI 处理未生成图片。",
  "Failed to load the background-removed image.": "去背景图片加载失败。",
  "Background removal failed to produce an image.": "移除背景未生成图片。",
  "AI did not return a prompt.": "AI 未返回提示词。",
  "Please enter a prompt.": "请输入提示词。",
  "For video generation, please select a single image or no elements.": "生成视频时，请只选择一张图片或取消选择。",
  "Video generation failed.": "视频生成失败。",
  "Video generation failed to produce a video.": "未生成视频。",
  "Generation failed.": "生成失败。",
  "Failed to load the generated image.": "生成的图片加载失败。",
  "Inpainting failed to produce an image.": "局部重绘未生成图片。",
  "Generation failed to produce any images.": "未生成任何图片。",
  "Generation failed to produce an image.": "未生成图片。",
  "card result is not an importable asset": "返回的卡片无法导入。",
  "format handler produced no importable asset": "格式处理未产生可导入的资产。",
  "PSD result has no composite image": "PSD 中没有合成图像。"
};

export function canvasMessage(message: string, language: string): string {
  if (language !== 'zho' || !message) return message;
  if (messages[message]) return messages[message];
  const patterns: [RegExp, (...parts: string[]) => string][] = [
    [/^Imported (\d+)\/(\d+) files \((\d+) items\)\. (.*)$/s, (_, done, total, count, detail) => `已导入 ${done}/${total} 个文件（${count} 个元素）。${canvasMessage(detail, language)}`],
    [/^(\d+) files were not imported\. (.*)$/s, (_, count, detail) => `${count} 个文件未导入。${canvasMessage(detail, language)}`],
    [/^Stopped at "([^"]*)"\. (.*)$/s, (_, name, detail) => `停止于“${name}”。${canvasMessage(detail, language)}`],
    [/^Skipped (\d+) files?: (.*)$/s, (_, count, detail) => `已跳过 ${count} 个文件：${detail}`],
    [/^Saving asset (\d+)\/(\d+): (.*)\.$/s, (_, done, total, name) => `正在保存资产 ${done}/${total}：${name}`],
    [/^Importing (\d+)\/(\d+): (.*)$/s, (_, done, total, name) => `正在导入 ${done}/${total}：${name}`],
    [/^Imported (\d+)\/(\d+) files · (\d+) canvas items(?: · (\d+) skipped)?$/, (_, done, total, count, skipped) => `已导入 ${done}/${total} 个文件 · ${count} 个画布元素${skipped ? ` · 跳过 ${skipped} 个文件` : ''}`],
    [/^Generating image (\d+) of (\d+)\.\.\.$/, (_, done, total) => `正在生成图片 ${done}/${total}…`],
  ];
  for (const [pattern, translate] of patterns) {
    const match = pattern.exec(message);
    if (match) return translate(...match);
  }
  const prefixes: [string, string][] = [
    ['Failed to perform AI operation: ', 'AI 处理失败：'],
    ['Failed to remove background: ', '移除背景失败：'],
    ['Failed to get prompt from image: ', '提取图片提示词失败：'],
    ['Video generation failed: ', '视频生成失败：'],
    ['Failed to rasterize selection: ', '选区栅格化失败：'],
    ['An error occurred during generation: ', '生成时发生错误：'],
    ['Could not import files. No files were placed. ', '导入失败，未放入任何文件。'],
    ['Import stopped because the destination project or board changed. No items were added to the new destination.', '目标项目或画板已变化，导入已停止，未向新目标添加内容。'],
  ];
  for (const [prefix, translated] of prefixes) {
    if (message.startsWith(prefix)) return translated + canvasMessage(message.slice(prefix.length), language);
  }
  return message;
}

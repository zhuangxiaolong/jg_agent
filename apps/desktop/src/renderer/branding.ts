/** 仅用于平台提示的显示名称；保留路径、URL、代码片段及底层原始数据。 */
export function engineText(value = '') {
  return value.split(/((?:[A-Za-z]:[\\/]|\\\\|https?:\/\/)[^\r\n"<>，。；：]*|```[\s\S]*?```|`[^`]*`)/g)
    .map((part, index) => index % 2 ? part : part.replace(/(?<![\\/A-Za-z0-9_.-])Codex(?: Runtime)?(?![\\/A-Za-z0-9_.-])/gi, '精工 Agent 引擎').replace(/(?<![\\/A-Za-z0-9_.-])Runtime(?![\\/A-Za-z0-9_.-])/g, '引擎'))
    .join('');
}
export function engineVersion(value = '') { return value.replace(/^codex(?:[- ]cli)?\s*/i, ''); }
export function toolPlatformText(value: string) {
  // Git 事件包含用户提交说明和真实分支信息，原样展示这些业务内容。
  return /^(?:已提交|已推送)\s/.test(value) ? value : engineText(value);
}
